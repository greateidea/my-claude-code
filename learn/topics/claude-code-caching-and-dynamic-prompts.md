# Claude Code 提示词缓存与动静态分离 — 彻底解释

## 提问

> 反复提及的缓存，我一直就不明白到底缓存什么，怎么就缓存了？
> 什么范围的提示词才算动态，又是在什么时候什么场景下动态注册的？
> `systemPromptSection` 和 `DANGEROUS_uncachedSystemPromptSection` 除了参数不一样到底区别是什么？

这三个问题指向同一个核心机制。要彻底理解，需要先搞清楚：**这里不是一层缓存，是两层，分别在不同层面工作。**

---

## 第一层：进程内缓存（Session Cache）

### 它是什么

一个普通的 `Map<string, string | null>`，存在进程内存里。

```typescript
// src/bootstrap/state.ts:1641
export function getSystemPromptSectionCache(): Map<string, string | null> {
  return STATE.systemPromptSectionCache  // 就是一个 Map
}

// 缓存读写
STATE.systemPromptSectionCache.set(name, value)  // 写
STATE.systemPromptSectionCache.clear()             // 清空
```

### 它缓存什么

缓存的是「compute 函数的返回值」—— 一个 section 的文本内容。key 是 section 的名字（如 `"memory"`），value 是 compute 函数算出来的字符串。

### 它怎么工作

```typescript
// src/constants/systemPromptSections.ts:43
export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<(string | null)[]> {
  const cache = getSystemPromptSectionCache()  // 拿到 Map

  return Promise.all(
    sections.map(async s => {
      // 关键判断：
      if (!s.cacheBreak && cache.has(s.name)) {
        return cache.get(s.name) ?? null  // ← 命中缓存，不执行 compute
      }
      // 未命中：执行 compute，写入缓存
      const value = await s.compute()
      setSystemPromptSectionCacheEntry(s.name, value)
      return value
    }),
  )
}
```

逻辑很简单：
- `cacheBreak === false` → 先查 Map，有就直接用，没有就 compute 然后存
- `cacheBreak === true` → 跳过 Map，每次强制 compute

### 什么时候清空

```typescript
// 只在以下时机清空：
clearSystemPromptSections()  // 定义在 systemPromptSections.ts

// 调用点：
// 1. /compact 压缩对话后 (postCompactCleanup.ts:62)
// 2. session 恢复时 (sessionRestore.ts:364, 388)
// 3. 进入/退出 worktree 时 (EnterWorktreeTool.ts:99, ExitWorktreeTool.ts:143)
// 4. 初始化时 (setup.ts:346)
```

**关键：两次用户消息之间不清空。** 用户发第一条消息时 compute 的 `memory` section，到用户发第二条消息时，如果没发生 compact/worktree 变更，直接复用缓存值。

### 为什么需要它

`loadMemoryPrompt()` 需要读 MEMORY.md 文件，`computeSimpleEnvInfo()` 需要执行 git 命令。这些 I/O 操作如果在每轮对话都重新执行，会累积延迟。缓存一次，整个会话期间复用。

---

## 第二层：API 级缓存（Anthropic Prompt Cache）

### 它是什么

这是 **Anthropic 服务端**的功能，跟你本地磁盘完全无关。

你每次调 API 都需要把 system prompt 全文（几千 token）通过网络发给 Anthropic 服务器。服务器上的模型要逐 token 计算注意力（KV cache）。Anthropic 的 Prompt Cache 功能做的是：如果两次请求的 prompt 前缀**内容哈希相同**，服务端直接复用之前算好的 KV 状态，跳过重复计算。

**结果：缓存命中的 token 只收 1/10 价格，响应延迟更低。**

关键区别：你本地硬编码的静态文本 ≠ 服务端不需要再处理。就像书在你书架上，但每次请人读还是得把书递给他——缓存省的不是「递书」的动作，是读者「我已经背下这章了，不用再读一遍」。

Claude Code 通过给 prompt 分块并标记 `cache_control` 来告诉服务端哪些块可以缓存：

Claude Code 通过给 prompt 分块并标记 `cache_control` 来控制这个行为。

```typescript
// src/services/api/claude.ts:345
export function getCacheControl({ scope }): {
  type: 'ephemeral'
  ttl?: '1h'          // 缓存有效期：5分钟或1小时
  scope?: CacheScope   // 'global' | 'org'
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL() && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),  // 只有 global 才传 scope
  }
}
```

### 它缓存什么

不是缓存 compute 函数的返回值，而是缓存**最终拼好的、发给 API 的文本块**。

### 它怎么工作

在 `buildSystemPromptBlocks()` 中，组装好的 `SystemPrompt`（string[]）被 `splitSysPromptPrefix()` 拆成若干块，每块带上 `cache_control` 标记：

```typescript
// src/services/api/claude.ts:3209
export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
): TextBlockParam[] {
  return splitSysPromptPrefix(systemPrompt).map(block => {
    return {
      type: 'text' as const,
      text: block.text,
      // 关键：只有 cacheScope 不为 null 的块才带 cache_control
      ...(enablePromptCaching &&
        block.cacheScope !== null && {
          cache_control: getCacheControl({ scope: block.cacheScope }),
        }),
    }
  })
}
```

分块结果：

```
块1: "x-anthropic-billing-header: cc_version=..."  → cacheScope: null   [不缓存]
块2: "You are Claude Code, Anthropic's official..." → cacheScope: null   [不缓存]
块3: [静态区全部内容，如行为规则/工具指南/语气风格] → cacheScope: 'global' [跨组织共享缓存]
块4: [动态区全部内容，如记忆/环境/MCP]              → cacheScope: null   [不缓存]
```

**块3 标注 `scope: 'global'` 的含义：** Anthropic API 识别到这个标记后，会用这个文本块的哈希值作为缓存 key。任何其他 Claude Code 用户，只要他们的静态区文本完全相同，就能命中这个缓存。**跨组织共享**。

### 为什么动态区不做服务端缓存（cacheScope: null）

因为动态区的内容每个用户不同（你的 CWD、你的 MEMORY.md、你的 MCP 服务器）。即使服务端缓存了你的动态块，也只有你自己的下一次请求才可能命中。而你的下一次请求的动态区可能内容变了（比如新连了一个 MCP 服务器），哈希对不上，缓存就白做了。

所以动态区直接不标记服务端缓存，节省复杂度。

**注意：这里说的「不缓存」特指第二层（Anthropic 服务端缓存）。第一层（进程内 Session Cache）对动态区仍然生效——`resolveSystemPromptSections()` 会缓存 compute 返回值，避免重复读取 MEMORY.md、重复执行 git 命令等本地 I/O 操作。**

分清两层：
- **第一层（本地进程缓存）：动态区 ✅ 有缓存** — 省本地 I/O
- **第二层（服务端 Prompt Cache）：动态区 ❌ 无缓存** — 省不了，因为每个用户内容不同

### 两层缓存的关系

```
用户发消息
  │
  ▼
getSystemPrompt() 被调用
  │
  ├─→ 静态区函数直接执行（纯字符串拼接，无 I/O，不需要本地缓存）
  │
  └─→ resolveSystemPromptSections(dynamicSections)
        │                   ↑
        │                   │
        │     【第一层：进程内 Session Cache】
        │     缓存的是 compute 函数的返回值（字符串）
        │     目的：避免重复 I/O（读 MEMORY.md、git 命令等）
        │
        ├─→ memory (cacheBreak: false)
        │     检查进程内 Map → 命中！跳过 loadMemoryPrompt() 磁盘读取
        │
        ├─→ env_info_simple (cacheBreak: false)
        │     检查进程内 Map → 命中！跳过 git 命令执行
        │
        └─→ mcp_instructions (cacheBreak: true)
              跳过 Map，强制 compute
              （因为 MCP 服务器可能在两轮对话之间连接/断开）
              │
              ▼
  systemPrompt 组装完成（string[]）
  │
  ▼
splitSysPromptPrefix() 拆分
  │                   ↑
  │                   │
  │     【第二层：Anthropic 服务端 Prompt Cache】
  │     缓存的是提示词文本的 KV 注意力状态
  │     目的：避免重复计费、降低延迟
  │
  ├─→ 静态块 → cacheScope: 'global'   所有用户共享 → 打一折
  └─→ 动态块 → cacheScope: null       每个用户不同 → 按原价
  │
  ▼
发给 Anthropic API
  │
  ├─→ 静态块哈希命中 → 计费 10% → 低延迟
  └─→ 动态块无缓存   → 计费 100% → 正常延迟
```

---

## 什么算「动态」？

现在可以精确回答了。

### 静态区的范围

静态区的内容满足一个条件：**对所有 Claude Code 用户，在所有项目中，每次都完全相同。**

具体包括（按顺序）：

1. **身份声明** — `"You are an interactive agent that helps users with software engineering tasks."`
2. **系统规则** — 权限模式说明、`<system-reminder>` 标签处理、hooks说明、自动压缩提示
3. **任务执行准则** — 代码风格规则（不画蛇添足、不引入安全漏洞、不创建没必要的文件）
4. **谨慎执行** — 破坏性操作需要确认的规则和示例
5. **工具使用规则** — "不要用 Bash 替代专用工具"、"最大化并行调用"
6. **语气风格** — 不用 emoji、`file:line` 引用格式、不要冒号后跟工具调用
7. **输出效率** — "直奔主题、简洁直接"

这些内容写死在 `prompts.ts` 的各个函数（`getSimpleIntroSection`、`getSimpleDoingTasksSection` 等）里。除了硬编码的条件分支（`USER_TYPE === 'ant'`），没有运行时动态内容。

### 动态区的范围

动态区的内容是**因用户、项目、会话、时间不同而变化的**。

| Section 名称 | 内容 | 为什么是动态的 |
|-------------|------|--------------|
| `session_guidance` | AskUserQuestion/Agent/Skill 工具的使用指导 | 取决于启用了哪些工具，不同用户 permissions 不同 |
| `memory` | loadMemoryPrompt() 的返回值 | 读取用户的 MEMORY.md 文件，每个用户不同 |
| `ant_model_override` | Ant 内部模型覆盖 | 仅有 Ant 员工需要 |
| `env_info_simple` | CWD、平台、Shell、OS 版本、模型信息 | 每个用户的机器环境不同 |
| `language` | 语言偏好 | 用户设置不同 |
| `output_style` | 输出风格（Explanatory/Learning/Default） | 用户选择不同 |
| `mcp_instructions` | MCP 服务器连接和工具说明 | 每轮都可能变化（服务器连接/断开） |
| `scratchpad` | 草稿板目录说明 | 项目特定 |
| `frc` | Function Result Clearing 说明 | 模型特定 |
| `summarize_tool_results` | 提醒记录重要工具结果 | 固定文本，但放在动态区因为它在边界标记之后 |
| `token_budget` | Token 预算指导 | 功能开关控制 |
| `brief` | Brief/Kairos 模式说明 | 功能开关控制 |

### 什么时候动态注册

注册发生在 `getSystemPrompt()` 被调用时，具体在函数体内部：

```typescript
// src/constants/prompts.ts:492-556
export async function getSystemPrompt(tools, model, ...): Promise<string[]> {
  // ... 前置处理（获取 skillToolCommands, outputStyleConfig, envInfo 等）

  // ↓ 这里构建注册表
  const dynamicSections = [
    systemPromptSection('session_guidance', () =>
      getSessionSpecificGuidanceSection(enabledTools, skillToolCommands),
    ),
    systemPromptSection('memory', () => loadMemoryPrompt()),
    systemPromptSection('env_info_simple', () =>
      computeSimpleEnvInfo(model, additionalWorkingDirectories),
    ),
    // ...
    DANGEROUS_uncachedSystemPromptSection(
      'mcp_instructions',
      () => getMcpInstructionsSection(mcpClients),
      'MCP servers connect/disconnect between turns',  // ← 必须写原因
    ),
    // ...
  ]

  // ↓ 这里解析（带缓存逻辑）
  const resolvedDynamicSections = await resolveSystemPromptSections(dynamicSections)

  // ↓ 拼接：静态 + 边界标记 + 动态
  return [
    getSimpleIntroSection(),
    getSimpleSystemSection(),
    // ... 更多静态内容
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    ...resolvedDynamicSections,
  ].filter(s => s !== null)
}
```

**每次 `getSystemPrompt()` 被调用**（即每次用户发消息），都会执行：
1. 重新构建 `dynamicSections` 数组（注册 compute 函数）
2. 调用 `resolveSystemPromptSections` 解析（带缓存判断）
3. 重新执行静态区函数（纯字符串拼接，无开销）

---

## `systemPromptSection` vs `DANGEROUS_uncachedSystemPromptSection` 的真正区别

### 源码对比

```typescript
// src/constants/systemPromptSections.ts

// 普通 section：会话内缓存
export function systemPromptSection(
  name: string,
  compute: ComputeFn,
): SystemPromptSection {
  return { name, compute, cacheBreak: false }  // ← cacheBreak: false
}

// 危险 section：每轮重新计算
export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,  // ← 必须传原因，但运行时被丢弃（下划线前缀 = unused）
): SystemPromptSection {
  return { name, compute, cacheBreak: true }   // ← cacheBreak: true
}
```

两个函数的返回值类型完全一样（`SystemPromptSection`），唯一的区别就是 `cacheBreak` 字段的值。

### 在 resolveSystemPromptSections 中的行为差异

```typescript
export async function resolveSystemPromptSections(sections) {
  const cache = getSystemPromptSectionCache()

  return Promise.all(
    sections.map(async s => {
      // ↓ 这里分叉
      if (!s.cacheBreak && cache.has(s.name)) {
        return cache.get(s.name)  // cacheBreak=false: 用缓存
      }
      const value = await s.compute()
      setSystemPromptSectionCacheEntry(s.name, value)
      return value
    }),
  )
}
```

- `cacheBreak: false` → 如果 Map 里有，**跳过 compute**，直接用缓存
- `cacheBreak: true` → **每次都跑 compute**，然后把新结果写回 Map

### 为什么要存在两种

`cacheBreak: false` 是默认选择。大部分 section 的内容在会话期间不会变：
- `memory` — MEMORY.md 文件在会话期间通常不会被其他进程修改
- `env_info_simple` — CWD、平台、OS 版本在会话期间不变
- `language` — 语言偏好不会中途改变

`cacheBreak: true` 用于内容**可能每轮变化**的 section：
- `mcp_instructions` — 用户可以随时连接或断开 MCP 服务器

具体场景：
1. 用户启动会话，没有 MCP 服务器 → `mcp_instructions` compute 返回 null
2. 用户键入 `/mcp add my-server` → 新 MCP 服务器连接
3. 用户发送下一条消息 → `getSystemPrompt()` 再次调用 → `mcp_instructions` 因为 `cacheBreak: true` 强制重新 compute → 返回新服务器的指令

如果用 `systemPromptSection`（`cacheBreak: false`），第 3 步会直接返回缓存的 null，模型不知道新 MCP 服务器的存在。

### 为什么叫 DANGEROUS

不是因为有 bug 风险，而是**经济成本**：

每次 `cacheBreak: true` 的 section compute 出新内容，动态块的文本就变了。文本变了 → 哈希变了 → Anthropic API 的 Prompt Cache 无法命中动态块 → **用户多付一次动态块的 input token 费用**。

虽然动态块本身就标注了 `cacheScope: null`（不跨会话缓存），但在**同一个会话的连续请求**之间，如果动态块内容不变，Anthropic 仍然可能缓存它（取决于 API 实现）。`cacheBreak: true` 增加了内容变化的概率，从而降低了缓存命中率。

`_reason` 参数强制开发者明确记录「为什么这个 section 必须每轮重新计算」—— 防止开发者偷懒把所有 section 都设成 `cacheBreak: true`。

---

## 回顾：三件事的关系

```
【第一层：进程内 Session Cache】— 在你本地，省 I/O
  │
  │  存在形式：Map<string, string | null>
  │  缓存内容：compute 函数的返回值（字符串）
  │  控制：cacheBreak 标志
  │  作用：避免重复执行昂贵的 compute（读 MEMORY.md、git 命令）
  │  粒度：每个 section 独立
  │
  │  动态区 ✅ 参与这层缓存
  │  静态区 ❌ 不参与（不需要，因为是纯字符串拼接，无 I/O）
  │
  ▼
【第二层：Anthropic 服务端 Prompt Cache】— 在服务器，省钱省时间
  │
  │  存在形式：服务端 KV 状态缓存（按内容哈希匹配）
  │  缓存内容：发给 API 的提示词文本的注意力计算结果
  │  控制：SYSTEM_PROMPT_DYNAMIC_BOUNDARY + cacheScope
  │  作用：避免重复付费处理相同的 prompt 前缀
  │  粒度：静态区作为一个整体块
  │
  │  静态区 ✅ 参与这层缓存（cacheScope: 'global'，跨组织共享）
  │  动态区 ❌ 不参与（cacheScope: null，每个用户不同，服务端缓存无意义）
  │
  ▼
静/动态分离
  │
  │  静态：对所有用户相同的硬编码行为规则 → 可以做服务端 global cache
  │  动态：因用户/会话而异的内容 → 本地缓存 compute 结果，但不做服务端缓存
  │  分界线：SYSTEM_PROMPT_DYNAMIC_BOUNDARY 标记
```

**一句话记住：第一层省 I/O（动态区用），第二层省 API 费（静态区用）。两者独立运作，各司其职。**

---

## 回到我们的项目

当前我们的 `buildSystemPrompt` 是这样的：

```typescript
export function buildSystemPrompt(tools, basePrompt, env?) {
  // 每次都完整拼接
  const envSection = env ? `# Environment\n...` : ''
  const toolList = tools.map(...)
  return `${basePrompt}${envSection}${thinkingInstruction}\n\nTools:\n${toolList}`
}
```

问题：
1. **没有缓存** — 每次 `handleSend` 都重新调用。虽然我们的 compute 很轻量（纯字符串拼接），但如果有朝一日要读取 MEMORY.md 或执行 git 命令，就需要缓存
2. **没有静/动态分离** — 行为规则和环境信息混在一个字符串里。即使行为规则不变，因为 CWD 变了，整个 prompt 都变了
3. **没有优先级层次** — 所有内容都在 system prompt 里，没有区分"铁律"和"参考信息"

如果要改进，优先级是：先做静/动态分离（简单的字符串数组 + 边界标记），等有 I/O 密集型 compute 时再加进程内缓存。API 缓存对 NVIDIA API 无效，暂时不需要。

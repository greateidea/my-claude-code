# Claude Code 提示词工程 — 深度源码分析

## 为什么写这个文档

上一份文档只是表面概括了提示词的内容变化，没有解释**设计思路和架构决策**。这份文档的目标是：读完你能自己实现一个类似的提示词系统。

---

## 一、整体架构：数据流全景

Claude Code 的提示词不是一段静态文本，而是一个**三层注入管道**，每层处理不同类型的信息：

```
                    ┌──────────────────┐
                    │  getSystemPrompt  │  ← 系统提示词工厂 (prompts.ts)
                    │  → string[]       │
                    └──────┬───────────┘
                           │
                    ┌──────▼───────────┐
                    │ buildEffective   │  ← 优先级路由 (systemPrompt.ts)
                    │ SystemPrompt     │     override > agent > custom > default
                    │ → SystemPrompt   │
                    └──────┬───────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
     ┌────────▼───┐ ┌──────▼──────┐ ┌──▼───────────┐
     │ System      │ │ User        │ │ System       │
     │ Prompt      │ │ Context     │ │ Context      │
     │ (工具规则,   │ │ (CLAUDE.md, │ │ (git status, │
     │  行为准则)   │ │  date)      │ │  injection)  │
     └────────┬───┘ └──────┬──────┘ └──┬───────────┘
              │            │            │
              │  appendSystemContext    │  prependUserContext
              │  追加到 sysprompt 末尾  │  包裹为第一条 user msg
              │            │            │
              └────────────┼────────────┘
                           │
                    ┌──────▼───────────┐
                    │ splitSysPrompt   │  ← 缓存分块 (api.ts)
                    │ Prefix           │     global/org/null
                    └──────┬───────────┘
                           │
                    ┌──────▼───────────┐
                    │  callModel()     │  ← 最终发送给 API
                    └──────────────────┘
```

**关键设计：三个注入通道各司其职**

| 通道 | 内容 | 注入位置 | 为什么这样设计 |
|------|------|---------|--------------|
| System Prompt | 工具规则、行为准则、语气风格 | `messages[0]` 的 `system` 角色 | 模型把它当「铁律」，优先级最高 |
| User Context | CLAUDE.md、当前日期 | 第一条 user message 的 `<system-reminder>` | 标记为「可参考但不强制执行」，不覆盖 system prompt 的权威性 |
| System Context | git status、最近 commits | 追加到 system prompt 末尾 | 技术上下文，适合在 system 层面告知模型环境状态 |

---

## 二、系统提示词的构造 (prompts.ts)

### 2.1 核心函数：getSystemPrompt()

```typescript
// src/constants/prompts.ts:445
export async function getSystemPrompt(
  tools: Tools,
  model: string,
  additionalWorkingDirectories?: string[],
  mcpClients?: MCPServerConnection[],
): Promise<string[]>
```

返回值是 `string[]`，**不是拼接好的一段文本**。为什么用数组？因为后面的缓存层（`splitSysPromptPrefix`）需要按照数组索引来划分静态区和动态区。

### 2.2 静态/动态分离机制

系统提示词分为两部分，由一个边界标记分隔：

```typescript
// src/constants/prompts.ts:115
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

最终的返回数组结构：

```typescript
return [
  // ===== 静态区 (cross-org cacheable) =====
  getSimpleIntroSection(),          // "You are an interactive agent..."
  getSimpleSystemSection(),         // 系统规则：权限模式、<system-reminder> 处理
  getSimpleDoingTasksSection(),     // 任务执行：代码风格、安全编码
  getActionsSection(),              // 风险操作确认规则
  getUsingYourToolsSection(tools),  // 工具使用规则：专用工具优先于 Bash
  getSimpleToneAndStyleSection(),   // 语气风格：无 emoji、file:line 引用
  getOutputEfficiencySection(),     // 输出效率：简洁直接

  // ===== 边界标记 =====
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,

  // ===== 动态区 (session-specific) =====
  ...resolvedDynamicSections,       // 由 systemPromptSections 注册表管理
]
```

**为什么这样设计？** 这是为 Prompt Cache 服务的。静态区的内容对所有用户都一样，可以用 `cache_scope: 'global'`（跨组织共享缓存）。动态区包含用户特定的记忆、环境信息等，不能缓存或用 `cache_scope: 'org'` 缓存。

### 2.3 动态区的注册表系统

动态区不是硬编码的，而是通过 `systemPromptSection()` 注册：

```typescript
// src/constants/systemPromptSections.ts
export function systemPromptSection(
  name: string,
  compute: ComputeFn,     // () => string | null | Promise<string | null>
): SystemPromptSection {
  return { name, compute, cacheBreak: false }  // cacheBreak: false = 会话内缓存
}

export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,        // 必须显式声明原因，防止滥用
): SystemPromptSection {
  return { name, compute, cacheBreak: true }   // 每轮都重新计算
}
```

注册表的设计模式：

```typescript
// src/constants/prompts.ts:492-556
const dynamicSections = [
  // 会话级缓存的（cacheBreak: false）—— 计算一次，/clear 时清除
  systemPromptSection('session_guidance',  () => getSessionSpecificGuidanceSection(...)),
  systemPromptSection('memory',            () => loadMemoryPrompt()),
  systemPromptSection('env_info_simple',   () => computeSimpleEnvInfo(...)),
  systemPromptSection('language',          () => getLanguageSection(settings.language)),

  // 每轮重新计算的（cacheBreak: true）—— 因为可能连接/断开 MCP 服务器
  DANGEROUS_uncachedSystemPromptSection(
    'mcp_instructions',
    () => getMcpInstructionsSection(mcpClients),
    'MCP servers connect/disconnect between turns',
  ),
]

// 一次性解析所有 section，带缓存
const resolvedDynamicSections = await resolveSystemPromptSections(dynamicSections)
```

**设计模式要点：**
1. 每个 section 是独立的 compute 函数，可测试、可替换
2. 用 `cacheBreak` 标记控制缓存粒度
3. `DANGEROUS_` 前缀是命名约定，警告该函数会破坏缓存
4. 解析函数（`resolveSystemPromptSections`）自动处理缓存命中/失效

### 2.4 转义出口：CLAUDE_CODE_SIMPLE

```typescript
// src/constants/prompts.ts:451
if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
  return [
    `You are Claude Code, Anthropic's official CLI for Claude.\n\n` +
    `CWD: ${getCwd()}\nDate: ${getSessionStartDate()}`,
  ]
}
```

一个环境变量就能跳过整个复杂的提示词构建。这在调试、第三方集成时非常有用。**教训：复杂的系统一定要留退路。**

---

## 三、优先级路由 (systemPrompt.ts)

### 3.1 buildEffectiveSystemPrompt()

在系统提示词构建完成后，还有一个优先级路由层：

```typescript
// src/utils/systemPrompt.ts:41
export function buildEffectiveSystemPrompt({
  mainThreadAgentDefinition,  // 自定义 Agent 定义
  toolUseContext,
  customSystemPrompt,         // --system-prompt CLI 参数
  defaultSystemPrompt,        // getSystemPrompt() 的输出
  appendSystemPrompt,         // 追加到末尾的提示词
  overrideSystemPrompt,       // 完全替换（如 loop mode）
}): SystemPrompt
```

优先级从高到低：

```
0. overrideSystemPrompt      → 完全替换（loop mode、特殊模式）
1. COORDINATOR_MODE         → 使用 coordinator 专用提示词
2. Agent (Custom Agent)      → proactive 模式：追加到 default 后面
                             → 其他模式：替换 default
3. customSystemPrompt        → --system-prompt CLI 参数
4. defaultSystemPrompt       → 完整的 getSystemPrompt() 输出
```

**关键细节——Agent 在 proactive 模式下的特殊处理：**

```typescript
// proactive 模式下：agent 提示词追加到 default 后面，不是替换
if (agentSystemPrompt && isProactiveActive()) {
  return asSystemPrompt([
    ...defaultSystemPrompt,                      // 保留完整的默认提示词
    `\n# Custom Agent Instructions\n${agentSystemPrompt}`,  // agent 指令追加
    ...(appendSystemPrompt ? [appendSystemPrompt] : []),
  ])
}

// 非 proactive 模式：agent 提示词完全替换 default
return asSystemPrompt([
  ...(agentSystemPrompt ? [agentSystemPrompt] : defaultSystemPrompt),
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])
```

**为什么这样设计？** Proactive 模式下，agent 是在默认的"自主代理"身份之上添加领域专长指令，就像给一个通用工程师配一个产品经理。而非 proactive 模式，agent 就是唯一的身份。

---

## 四、CLAUDE.md 的加载机制 (claudemd.ts)

### 4.1 这是什么

CLAUDE.md 不是系统提示词的一部分，它通过 **User Context** 通道注入。具体流程：

```
1. getMemoryFiles()  →  发现并读取所有 CLAUDE.md / .claude/CLAUDE.md / .claude/rules/*.md
2. filterInjectedMemoryFiles()  →  如果需要，过滤掉 AutoMem/TeamMem
3. getClaudeMds(files)  →  格式化为带描述的前缀文本
4. getUserContext()  →  将 CLAUDE.md 文本和日期打包成 context 对象
5. prependUserContext(messages, context)  →  包装为第一条 user message 的 <system-reminder>
```

### 4.2 文件发现的优先级顺序

```typescript
// src/utils/claudemd.ts 开头的注释文档
/**
 * 加载顺序（后面的优先级更高）：
 *
 * 1. Managed  (/etc/claude-code/CLAUDE.md, /etc/claude-code/.claude/rules/*.md)
 *    → 全局管理员策略，所有用户都必须遵循
 * 2. User     (~/.claude/CLAUDE.md, ~/.claude/rules/*.md)
 *    → 用户私有的全局指令，适用于所有项目
 * 3. Project  (CLAUDE.md, .claude/CLAUDE.md, .claude/rules/*.md)
 *    → 从根目录到 CWD 逐级向上发现，离 CWD 越近的优先级越高
 * 4. Local    (CLAUDE.local.md)
 *    → 私有项目指令，不提交到 git
 */
```

### 4.3 路径发现策略

项目级别的 CLAUDE.md 是从 CWD 开始**向上遍历**到根目录：

```
CWD = /Users/bigorange/projects/my-app/src/components/

发现顺序（后面的覆盖前面的）:
1. /Users/bigorange/projects/my-app/CLAUDE.md
2. /Users/bigorange/projects/my-app/.claude/CLAUDE.md
3. /Users/bigorange/projects/my-app/.claude/rules/*.md
4. /Users/bigorange/projects/my-app/src/CLAUDE.md         ← 离 CWD 更近
5. /Users/bigorange/projects/my-app/src/.claude/CLAUDE.md  ← 离 CWD 更近
6. /Users/bigorange/projects/my-app/src/components/CLAUDE.md ← 最近，优先级最高
```

**设计动机：** 子目录的 CLAUDE.md 可以覆盖父目录的规则。例如，`src/legacy/CLAUDE.md` 可以放宽某些代码风格限制。

### 4.4 @include 指令

CLAUDE.md 可以通过 `@path` 语法引用其他文件：

```
# 我的项目规则

@docs/coding-style.md
@~/.claude/shared-rules.md
@/etc/company-policy.md

## 额外规则
- 本文中的指令优先级高于引用的文件
```

实现细节：
- `@path` 是相对路径（等价于 `@./path`）
- `@~/path` 从 home 目录解析
- `@/path` 是绝对路径
- 循环引用检测：追踪已处理的文件路径
- 不存在的文件静默忽略
- 只允许文本文件扩展名（防止加载图片/PDF）

### 4.5 条件规则

`.claude/rules/*.md` 支持通过 frontmatter 的 `paths` 字段实现条件匹配：

```markdown
---
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
---
# TypeScript 规则
这个文件中的规则只在处理匹配 glob 的文件时生效
```

只有操作的文件路径匹配 `paths` glob 时，该规则文件才会被加载。**这大大减少了无关规则对提示词的污染。**

### 4.6 格式化输出

```typescript
// src/utils/claudemd.ts:1153
export const getClaudeMds = (memoryFiles: MemoryFileInfo[]): string => {
  const memories: string[] = []

  for (const file of memoryFiles) {
    if (file.content) {
      const description =
        file.type === 'Project'
          ? ' (project instructions, checked into the codebase)'
          : file.type === 'Local'
            ? " (user's private project instructions, not checked in)"
            : " (user's private global instructions for all projects)"

      memories.push(`Contents of ${file.path}${description}:\n\n${file.content}`)
    }
  }

  if (memories.length === 0) return ''

  // 前缀是关键：明确告知模型这些指令具有最高优先级
  return `${MEMORY_INSTRUCTION_PROMPT}\n\n${memories.join('\n\n')}`
}

// 前缀内容：
// "Codebase and user instructions are shown below. Be sure to adhere to
//  these instructions. IMPORTANT: These instructions OVERRIDE any default
//  behavior and you MUST follow them exactly as written."
```

**关键点：** `MEMORY_INSTRUCTION_PROMPT` 这句话不是随便写的。"OVERRIDE any default behavior" 明确告诉模型：CLAUDE.md 的指令优先级高于系统提示词中的默认行为。

---

## 五、上下文组装 (context.ts + api.ts)

### 5.1 三种上下文

```typescript
// src/context.ts

// System Context — git 状态等环境元数据
export const getSystemContext = memoize(async () => {
  const gitStatus = await getGitStatus()  // branch, status, recent commits
  return {
    ...(gitStatus && { gitStatus }),
    ...(injection && { cacheBreaker: `[CACHE_BREAKER: ${injection}]` }),
  }
})

// User Context — CLAUDE.md + 当前日期
export const getUserContext = memoize(async () => {
  const claudeMd = getClaudeMds(await getMemoryFiles())
  return {
    ...(claudeMd && { claudeMd }),
    currentDate: `Today's date is ${getLocalISODate()}.`,
  }
})
```

两个函数都用 `memoize` 包裹，会在会话期间缓存结果。`/clear` 或 `/compact` 时清除缓存。

### 5.2 注入位置

```typescript
// src/utils/api.ts

// System Context 追加到 system prompt 末尾
export function appendSystemContext(
  systemPrompt: SystemPrompt,
  context: { [k: string]: string },
): string[] {
  return [
    ...systemPrompt,
    Object.entries(context)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
  ].filter(Boolean)
}

// User Context 包装为第一条 user message
export function prependUserContext(
  messages: Message[],
  context: { [k: string]: string },
): Message[] {
  return [
    createUserMessage({
      content: `<system-reminder>
As you answer the user's questions, you can use the following context:
${Object.entries(context).map(([key, value]) => `# ${key}\n${value}`).join('\n')}

IMPORTANT: this context may or may not be relevant to your tasks.
You should not respond to this context unless it is highly relevant to your task.
</system-reminder>`,
      isMeta: true,
    }),
    ...messages,
  ]
}
```

**设计精妙之处：**
- CLAUDE.md 放在 `<system-reminder>` 里，模型知道这是"额外参考信息"，不会把它当成用户的直接指令
- 加了 "may or may not be relevant" 的免责声明，防止模型对不相关的 CLAUDE.md 内容过度反应
- `isMeta: true` 标记让 UI 层不渲染这条消息

### 5.3 git status 的获取

```typescript
// src/context.ts:36
export const getGitStatus = memoize(async (): Promise<string | null> => {
  const isGit = await getIsGit()
  if (!isGit) return null  // 非 git 仓库直接跳过

  // 并行获取5个信息
  const [branch, mainBranch, status, log, userName] = await Promise.all([
    getBranch(),
    getDefaultBranch(),
    execFileNoThrow(gitExe(), ['status', '--short']),
    execFileNoThrow(gitExe(), ['log', '--oneline', '-n', '5']),
    execFileNoThrow(gitExe(), ['config', 'user.name']),
  ])

  // status 截断到 2000 字符
  const truncatedStatus = status.length > MAX_STATUS_CHARS
    ? status.substring(0, MAX_STATUS_CHARS) + '\n... (truncated...)'
    : status

  return [
    `This is the git status at the start of the conversation. ...`,
    `Current branch: ${branch}`,
    `Main branch: ${mainBranch}`,
    `Status:\n${truncatedStatus || '(clean)'}`,
    `Recent commits:\n${log}`,
  ].join('\n\n')
})
```

**设计细节：**
- `memoize` 缓存（会话期间 git status 不变）
- `MAX_STATUS_CHARS = 2000` 防止超大 repo 的 status 撑爆 context
- "at the start of the conversation" 明确告知模型这是快照，不是实时的
- 截断时附带提示告诉模型如何获取完整信息

---

## 六、缓存策略 (api.ts: splitSysPromptPrefix)

### 6.1 三种缓存模式

Claude Code 支持 Anthropic API 的 Prompt Cache 功能。`splitSysPromptPrefix` 根据边界标记将提示词数组分块并标记缓存范围：

```typescript
// src/utils/api.ts:321
export function splitSysPromptPrefix(
  systemPrompt: SystemPrompt,
  options?: { skipGlobalCacheForSystemPrompt?: boolean },
): SystemPromptBlock[]
```

**模式 1 — MCP 工具存在时 (skipGlobalCacheForSystemPrompt=true)：**
```
[attribution header]     → cacheScope: null    (不缓存)
[sysprompt prefix]       → cacheScope: 'org'   (组织级缓存)
[所有其他内容合并]        → cacheScope: 'org'   (组织级缓存)
```
因为 MCP 工具来自外部服务器，使用全局缓存可能泄露工具信息给其他组织。

**模式 2 — 有边界标记 + 1P Anthropic：**
```
[attribution header]     → cacheScope: null     (不缓存)
[sysprompt prefix]       → cacheScope: null     (不缓存)
[静态区内容]             → cacheScope: 'global' (跨组织共享！)
[动态区内容]             → cacheScope: null     (不缓存)
```
静态区对所有用户相同，可以跨组织共享，大幅降低 API 成本。

**模式 3 — 默认（第三方 API 或没有边界标记）：**
```
[attribution header]     → cacheScope: null    (不缓存)
[sysprompt prefix]       → cacheScope: 'org'   (组织级缓存)
[所有其他内容合并]        → cacheScope: 'org'   (组织级缓存)
```
第三方 API 不支持跨组织缓存，降级为组织级。

### 6.2 缓存的经济意义

为什么花这么多工程复杂度在缓存上？Claude Code 的系统提示词大约 **2500-4000 tokens**。每次 API 调用都重传这部分：
- 无缓存：每轮都付 2500+ input tokens 的费用
- 有 global 缓存（5 分钟 TTL）：所有用户共享缓存，大幅降低成本和延迟
- 有 org 缓存：同组织用户共享

---

## 七、记忆系统 (memdir/)

### 7.1 核心机制

记忆系统通过 `loadMemoryPrompt()` 注入到系统提示词的动态区：

```typescript
// src/memdir/memdir.ts:419
export async function loadMemoryPrompt(): Promise<string | null> {
  const autoEnabled = isAutoMemoryEnabled()

  if (autoEnabled) {
    const autoDir = getAutoMemPath()
    await ensureMemoryDirExists(autoDir)
    return buildMemoryLines('auto memory', autoDir, ...)
  }
  return null
}
```

`loadMemoryPrompt()` 返回的不是 MEMORY.md 的内容，而是**一段如何使用记忆系统的提示词**。实际的 MEMORY.md 内容作为 `MEMORY.md` section 附加在末尾。

### 7.2 提示词内容

这段提示词非常长（~200 行），包含：

1. **记忆类型定义**（user/feedback/project/reference）— 每种类型有 description/when_to_save/how_to_use/examples
2. **不应保存的内容** — 代码模式、架构、git 历史（这些可从代码中推导）
3. **如何保存** — 两步流程：写文件 → 更新 MEMORY.md 索引
4. **何时读取** — 对话开始时、用户引用之前对话时
5. **记忆检索** — "如果记忆说的是 X，先验证 X 是否仍然为真"
6. **与其他持久化的区别** — plan/task/memory 的适用场景

### 7.3 设计原则

记忆系统提示词的设计体现了一个关键原则：**告诉模型「不要做什么」比告诉它「要做什么」更重要。**

`WHAT_NOT_TO_SAVE_SECTION` 明确列举了不应保存的内容：
- 代码模式/约定/架构 → 可从代码推导
- git 历史/最近变更 → `git log` 是权威来源
- 调试方案/fix 方法 → 修复在代码中，commit message 有上下文
- CLAUDE.md 已有内容 → 不要重复
- 临时任务详情 → 用 plan/tasks

---

## 八、完整调用流程 (QueryEngine.ts)

### 8.1 从发送消息到 API 调用

```typescript
// src/QueryEngine.ts:291-329 (简化版)
async ask() {
  // 1. 获取三块上下文（并行）
  const { defaultSystemPrompt, userContext, systemContext } =
    await fetchSystemPromptParts({
      tools,
      mainLoopModel,
      mcpClients,
      customSystemPrompt: customPrompt,
    })

  // 2. 对 userContext 做额外处理（coordinator 模式）
  const userContext = {
    ...baseUserContext,
    ...getCoordinatorUserContext(mcpClients),
  }

  // 3. 组装最终 system prompt
  const systemPrompt = asSystemPrompt([
    ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
    ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
    ...(appendSystemPrompt ? [appendSystemPrompt] : []),
  ])

  // 4. 将组装好的 prompt + context 发送给 query 循环
  for await (const message of query({
    messages,
    systemPrompt,     // 组装好的系统提示词
    userContext,      // CLAUDE.md + date（会注入为第一条 user msg）
    systemContext,    // git status（会追加到 system prompt 末尾）
    ...
  })) {
    // 处理响应...
  }
}
```

### 8.2 fetchSystemPromptParts 的并行优化

```typescript
// src/utils/queryContext.ts:44
export async function fetchSystemPromptParts(...) {
  // 三个 fetch 并行执行！
  const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
    customSystemPrompt !== undefined
      ? Promise.resolve([])                    // 有自定义 prompt 就跳过
      : getSystemPrompt(tools, model, ...),     // 否则构建完整系统提示词
    getUserContext(),                           // CLAUDE.md + date
    customSystemPrompt !== undefined
      ? Promise.resolve({})                     // 有自定义 prompt 就跳过
      : getSystemContext(),                     // git status
  ])
  return { defaultSystemPrompt, userContext, systemContext }
}
```

**设计细节：**
- 三个数据源完全独立，并行获取减少延迟
- 如果使用自定义系统提示词（`--system-prompt`），跳过默认的 getSystemPrompt 和 getSystemContext
- `memoize` 确保每个源在会话期间只计算一次

---

## 九、与我们项目的对比

| 维度 | Claude Code | 我们的项目 | 差距分析 |
|------|------------|-----------|---------|
| 提示词结构 | 静态/动态分离，缓存标记 | 单一 BASE_PROMPT 字符串 | 我们没有缓存概念，但这对 NVIDIA API 也无效 |
| 上下文注入 | 三通道：System + User + System Context | buildSystemPrompt 中拼接 env 信息 | 我们把所有信息都放在 system prompt 里，缺少优先级层次 |
| CLAUDE.md | 完整发现链：Managed→User→Project→Local | 项目根单文件读取 | 缺少向上遍历、@include、条件规则 |
| 记忆系统 | 类型化记忆 + MEMORY.md 索引 | 简化的 frontmatter 文件系统 | 设计思路一致，但缺少类型系统提示词和索引管理 |
| 动态区 | 注册表 + 缓存控制 | 无 | 我们每轮都在 buildSystemPrompt 中重建 |
| 优先级路由 | 5 级 override→coordinator→agent→custom→default | 无 | 不支持自定义 agent 或系统提示词覆盖 |

---

## 十、可以立即学习的关键设计决策

### 10.1 用 `<system-reminder>` 分离优先级

Claude Code 把 CLAUDE.md 放在 `<system-reminder>` 里而不是 system prompt 里的原因：

```
System Prompt → 模型当"铁律"，必须遵守
<system-reminder> → 模型当"参考信息"，视相关性使用
```

这个区分很重要。如果把项目特定的代码规范放在 system prompt 里，模型可能过度强制执行。但如果放在 `<system-reminder>` 里，模型会判断：当前任务是否跟这个规范相关？

### 10.2 边界标记 + 数组 = 灵活缓存

用 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 字符串作为数组元素分隔缓存区域，比用两个独立变量更灵活——第三方 API 可以忽略边界直接拼接，1P API 可以利用边界优化缓存。

### 10.3 注册表模式替代硬编码

动态区的注册表系统（`systemPromptSection`）让添加/删除提示词 section 变得非常简单，不需要修改 `getSystemPrompt` 的主逻辑。

### 10.4 所有内容都有截断上限

- git status: 2000 字符
- MEMORY.md: 200 行 / 25KB
- 单个记忆文件: 40000 字符

**不加限制的上下文会污染模型注意力。** 截断 + 明确提示（"如需更多信息请使用 BashTool"）是更好的方案。

### 10.5 memoize 无处不在

`getSystemContext`、`getUserContext`、`getSystemPrompt` 中的 section 计算都用 `memoize` 缓存。会话期间这些信息通常不变，缓存可以显著减少 I/O 和计算开销。

### 10.6 转义出口

`CLAUDE_CODE_SIMPLE` 环境变量可以让整个复杂的提示词系统变成两行。在调试模型行为时，这个开关非常有用——可以快速判断"是提示词的问题还是模型的问题"。

# `<system-reminder>` 与 MEMORY.md 记忆系统 — 彻底解释

## 一、`<system-reminder>` 是什么

### 它不是 API 特性

`<system-reminder>` **不是** Anthropic API 的特殊标签，也不是任何模型的特殊 token。模型不会在 tokenizer 层面识别这个标签——它只是普通文本。

### 它是一个 prompt engineering 约定

它的工作原理基于两点：

**1. XML/HTML 语义边界**

LLM 的训练数据包含大量 HTML/XML，模型学会了：被标签包裹的内容是一个**独立的语义块**。`<system-reminder>...</system-reminder>` 告诉模型：「以下内容是一个封闭的上下文单元，不要把它跟外面的内容混淆」。

**2. 角色定位（System vs User）**

关键不在于标签本身，而在于**它在哪里出现**：

```
API 请求：
messages: [
  { role: "system",  content: "你是 CLI 助手，必须遵守工具规则..." },  ← 铁律
  { role: "user",    content: "<system-reminder>\nCLAUDE.md 内容...\n</system-reminder>" },  ← 参考
  { role: "user",    content: "帮我修复登录 bug" },  ← 实际任务
]
```

模型在训练中学会了：
- `system` 消息 = 权威指令，必须遵守
- `user` 消息 = 任务请求，可能包含背景信息

`<system-reminder>` 放在 **user 消息**里，所以模型把它当「参考材料」，不是「硬性规则」。标签内部的免责声明（"may or may not be relevant"）进一步降低了优先级。

### 跟 System Prompt 的本质区别

| | System Prompt | `<system-reminder>` |
|---|---|---|
| 角色 | `system` | `user`（标签内） |
| 模型态度 | 铁律，无条件遵守 | 参考，视相关性选择性使用 |
| 放什么 | 工具规则、行为准则、安全边界 | CLAUDE.md、日期、项目背景 |
| 为什么这样分 | 行为规则必须强制执行 | 项目指令不应覆盖安全规则 |

**举个例子：** 如果 CLAUDE.md 里写了「尽量用简短的回复」，放在 system prompt 里，模型会无条件简写——包括权限确认、错误提示。放在 `<system-reminder>` 里，模型会判断：常规回复简写没问题，但权限确认不能省。

### 这个名字是 Claude Code 发明的

"system-reminder" 这个名字暗示：**是系统在想你提醒一些事情，不是用户在给你下指令**。这种命名直接塑造了模型对内容的态度。

类比：你跟人说「对了提醒你一下，今天可能会下雨」vs 「你今天必须带伞」。前者是提醒，后者是指令。`<system-reminder>` 就是前者。

### 你刚才其实看到了一个实例

在这段对话中，系统自动注入了：

```
<system-reminder>
The task tools haven't been used recently. If you're working on tasks that
would benefit from tracking progress, consider using TaskCreate to add new tasks...
</system-reminder>
```

这不是用户在让我用 TaskCreate，是系统在提醒我有一个可用的功能。这就是 `<system-reminder>` 的语义——**提醒，不是指令**。

---

## 二、MEMORY.md 记忆系统

### 它是什么

一个**基于 Markdown 文件的持久化记忆系统**，让模型在后续会话中能「记住」用户偏好、项目事实、反馈等。

存储位置：`~/.claude/projects/<project-hash>/memory/`

### 架构：索引 + 文件

MEMORY.md **不是**记忆内容本身，而是一个**索引文件**（像目录）：

```
memory/
├── MEMORY.md              ← 索引（一行一个条目，指向具体文件）
├── user_role.md           ← 记忆 1
├── feedback_testing.md    ← 记忆 2
└── project_mergefreeze.md ← 记忆 3
```

**MEMORY.md 格式（索引，无 frontmatter）：**

```
- [User Role](user_role.md) — 用户是数据科学家，专注可观测性
- [No mocks in tests](feedback_testing.md) — 集成测试不 mock 数据库
- [Merge Freeze](project_mergefreeze.md) — 2026-03-05 起冻结合入
```

**单个记忆文件格式（内容，有 YAML frontmatter）：**

```markdown
---
name: User Role
description: 用户的角色、目标、职责和知识水平
type: user
---

我是一位资深后端工程师，Go 写了十年，但这是我的第一次接触 React。
```

### 四种记忆类型

| 类型 | 用途 | 何时保存 | 示例 |
|------|------|---------|------|
| **user** | 用户角色、目标、偏好、知识水平 | 了解用户的任何信息时 | "用户是数据科学家，目前关注日志系统" |
| **feedback** | 用户对你工作方式的反馈 | 用户纠正你的方法或肯定你的选择时 | "用户说了测试不要 mock 数据库" |
| **project** | 项目事实、决策、约束、背景 | 了解到谁在做什么、为什么、何时交付时 | "合并冻结从 3/5 开始，移动端发版" |
| **reference** | 外部资源的指针 | 了解到外部信息源时 | "管道 bug 在 Linear 项目 INGEST 追踪" |

### 两步保存流程

```
1. 写记忆文件 (user_role.md, feedback_testing.md, ...)
   └─→ frontmatter (name, description, type) + markdown 正文

2. 在 MEMORY.md 添加索引行
   └─→ - [Title](file.md) — 一句话描述（~150 字符内）
```

**为什么是两步？** MEMORY.md 始终加载到上下文（200 行限制），单个记忆文件按需加载。索引 → 内容分离避免上下文膨胀。

### 什么**不应该**保存（最关键的设计）

这是记忆系统最精妙的部分——告诉模型**不要**记录什么：

```
❌ 代码模式/约定/架构 → 从代码中可推导
❌ Git 历史/最近变更 → git log 是权威来源
❌ 调试方案/fix 方法 → 修复在代码中，commit message 有上下文
❌ 已在 CLAUDE.md 中的内容 → 不要重复
❌ 临时任务详情 → 用 plan/tasks 系统
```

**设计原则：防止模型把记忆系统当日志用。** 不加限制的话，模型每轮对话都会往里塞东西，一个月后 MEMORY.md 变成一个无法维护的垃圾堆。

### 与其他持久化机制的关系

| 机制 | 生命周期 | 什么情况下使用 |
|------|---------|--------------|
| **Memory** | 跨会话持久 | 用户的角色、偏好、项目约束等可在未来复用的事实 |
| **Plan** | 当前会话 | 当前会话中需要实施的非平凡任务方案 |
| **Task** | 当前会话 | 当前任务拆解出的执行步骤 |
| **CLAUDE.md** | 项目持久（git） | 人工维护的项目规范和指引 |

### 加载时机

每次系统提示词构建时，`loadMemoryPrompt()` 在动态区执行：

1. 检查 auto-memory 功能是否开启
2. 确保 `~/.claude/projects/<hash>/memory/` 目录存在
3. 返回一段 ~200 行的**使用指南**（告诉模型如何使用记忆系统）
4. 不是直接返回 MEMORY.md 的内容——内容由后续的机制加载

### 可靠性设计

记忆可能是**过时的**（函数改名、文件被删、规则变更）。所以加载记忆时会提示：
- 如果记忆说 X 存在，先 grep 验证
- 如果记忆跟当前代码冲突，以当前代码为准，并更新过时的记忆
- 永远不要因为记忆说某物存在就假定它仍存在

---

## 三、二者跟 Claude Code 流水线的对应关系

```
getSystemPrompt()
  ├── 静态区
  │    └── 行为规则、工具指南、语气风格（硬编码）
  │
  ├── __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__
  │
  └── 动态区
       ├── memory section    ← loadMemoryPrompt() 的结果（如何使用记忆的指南）
       ├── env_info_simple   ← CWD、平台、模型信息
       └── mcp_instructions  ← MCP 服务器连接状态

User Context（注入为第一条 user message）
  └── <system-reminder>
       ├── CLAUDE.md         ← 项目规则（实际的 CLAUDE.md 文件内容）
       └── currentDate       ← 今天的日期
```

**核心逻辑：** system prompt 教模型「如何行为」和「如何使用工具（如记忆系统）」，`<system-reminder>` 提供「项目特定的背景信息」。两者通过不同的通道注入，模型就知道哪个是铁律，哪个是参考。

---

## 四、我们项目的当前状态

| 能力 | 状态 |
|------|------|
| System prompt 静态/动态分离 | ✅ 已完成，有 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` |
| CLAUDE.md 加载和注入 | ✅ 已完成，走 `<system-reminder>` 注入 |
| `<system-reminder>` 通道 | ✅ 已完成，`buildUserContext()` 实现了 |
| CLAUDE.md 向上遍历 | ✅ 已完成，从 cwd 向上遍历到 git root |
| 记忆系统（完整实现） | ✅ 已完成，含类型指南 prompt + MEMORY.md 索引 |

记忆系统已完整实现：`src/services/memory.ts` 中包含 ~150 行的记忆使用指南（4 种类型定义、不保存清单、两步保存流程、检索验证规则），在 `buildSystemPrompt` 中作为动态 section 注入，模型通过现有 Write/Read 工具操作记忆文件。

---

## 五、附录：记忆系统完整提示词

以下是注入到 system prompt 动态区的实际记忆使用指南，约 150 行。模型每次对话开始时都会收到这段指令。

### 5.1 核心设计：告诉模型「如何使用」记忆系统

这段提示词不是 MEMORY.md 的内容——它是**告诉模型如何操作**记忆系统的使用手册。类比：这不是数据库里的数据，而是数据库的 API 文档。

```
# Auto memory

You have a persistent, file-based memory system at the path shown in the
Environment section below. Build it up over time so that future conversations
can have context about the user's preferences and the project.

## Types of memory

### user
Contain information about the user's role, goals, responsibilities, and knowledge.
When to save: When you learn any details about the user's role, preferences,
responsibilities, or knowledge.
How to use: Tailor your future behavior to the user's profile.

### feedback
Guidance the user has given you about how to approach work — both what to avoid
and what to keep doing.
When to save: Any time the user corrects your approach OR confirms a non-obvious
approach worked. Corrections are easy to notice; confirmations are quieter — watch
for them.
How to use: Let these guide future behavior so the user doesn't need to repeat
the same guidance.

### project
Information about ongoing work, goals, initiatives, bugs, or incidents within the
project that is not derivable from the code or git history.
When to save: When you learn who is doing what, why, or by when. Always convert
relative dates to absolute dates (e.g., "Thursday" → "2026-05-02").
How to use: Better understand the context behind the user's request and make more
informed suggestions.

### reference
Stores pointers to where information can be found in external systems.
When to save: When you learn about resources in external systems and their purpose.
How to use: When the user references an external system.
```

### 5.2 最关键的段落：什么不保存

```
## What NOT to save in memory

- Code patterns, conventions, architecture, file paths — can be derived from
  reading the current project state.
- Git history, recent changes — `git log` / `git blame` are authoritative.
- Debugging solutions or fix recipes — the fix is in the code; commit messages
  have the context.
- Anything already documented in CLAUDE.md files.
- Ephemeral task details: in-progress work, temporary state, current conversation
  context.

These exclusions apply even when the user explicitly asks you to save. If they
ask you to save a PR list or activity summary, ask what was *surprising* or
*non-obvious* about it — that is the part worth keeping.
```

**为什么这段话是记忆系统最重要的部分？** 没有它，模型会把记忆系统当聊天日志用。每轮对话都往里塞东西 → 一个月后 MEMORY.md 膨胀到几千行 → 每次加载都消耗大量 token → 系统变慢 → 用户关掉记忆功能。

"即使你明确问我保存，也要追问什么是意外的/非显而易见的"这一条尤其重要——它让模型成为一个有判断力的编辑，而不是无脑的记录员。

### 5.3 两步保存流程

```
## How to save memories

Step 1 — write the memory to its own file using the Write tool with YAML frontmatter:

---
name: Memory name
description: One-line description
type: user|feedback|project|reference
---

Memory content.

Step 2 — add a pointer to that file in MEMORY.md (index file):
- [Title](file.md) — one-line hook (under ~150 characters)

Never write memory content directly into MEMORY.md — it's an index, not content.
MEMORY.md lines after 200 will be truncated, so keep the index concise.
Always check if an existing memory can be updated before creating a new one.
```

### 5.4 记忆检索与验证

```
## When to access memories

- When memories seem relevant, or the user references prior-conversation work.
- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md
  were empty.

## Before recommending from memory

A memory that names a specific function, file, or flag is a claim that it
existed *when the memory was written*. Verify before recommending:
- If the memory names a file path: check the file exists.
- If the memory names a function or flag: grep for it.
- "The memory says X exists" is not the same as "X exists now."
```

**这个验证机制是记忆系统的「安全网」。** 记忆本质上是带时间戳的声明——代码在变，人在变，记忆可能过时。模型被明确要求：先验证，再行动。如果发现冲突，以当前代码为准，并更新或删除过时记忆。

### 5.5 与其他持久化机制的边界

```
## Memory and other forms of persistence

- Plan: for non-trivial implementation tasks within the current conversation
- Tasks: for breaking work into discrete steps within the current conversation
- Memory: for facts that persist across sessions (user preferences, project
  constraints)
- CLAUDE.md: for human-maintained project instructions (checked into git)

Do not duplicate CLAUDE.md content in memory.
```

### 5.6 提示词工程分析

这段提示词有一些值得注意的设计细节：

1. **用「类型」驱动行为**：不是笼统地说「记住重要的事」，而是定义 4 种具体类型，每种有精确的 when_to_save/how_to_use。这比模糊指令有效得多，因为模型可以把「我要保存记忆」映射为一个具体的判断流程：「这是 user 类型吗？符合 when_to_save 条件吗？」

2. **「不保存」清单 > 「保存」清单**：排除规则比包含规则更重要，因为模型天然倾向于记录一切。先限定什么不保存，剩下的才值得保存。

3. **具体 + 可操作**：不说「确保记忆不会过时」，而是说「如果记忆说 X 存在，先检查文件是否存在」。给模型一个它真的能做的动作。

4. **MEMORY.md 的 ~150 字符 / 200 行硬限制**：防止索引文件膨胀。如果索引太大，每次加载都消耗大量 token，反过来又侵蚀了记忆系统本身的价值。

---

## 六、我们项目的实现与 Claude Code 的对比

| 维度 | Claude Code | 我们的实现 |
|------|------------|-----------|
| 存储路径 | `~/.claude/projects/<hash>/memory/` | `~/.myclaude/projects/<sanitized-path>/memory/` |
| 路径算法 | MD5 hash of project root | 字符串替换 `/` → `-`（可读性优先） |
| 记忆类型 | 4 种（user/feedback/project/reference） | 相同 |
| 提示词注入 | 系统提示词动态 section | 相同 |
| MEMORY.md 加载 | 始终加载到上下文（200 行截断） | 相同 |
| Auto-memory 开关 | 可配置开关 | 始终开启（简化） |
| 保存机制 | 专用记忆工具 | 使用现有 Write/Read 工具 |
| 提示词内容 | ~200 行 | ~150 行（去掉了 Claude Code 特有的配置相关段落） |

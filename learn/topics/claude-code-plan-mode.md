# Claude Code Plan 模式深度分析

## 1. 什么是 Plan 模式？

Plan 模式是 Claude Code 的**先想后做**机制。当面对复杂任务时，进入一个受限的「规划阶段」：只能读代码、搜索、分析、写方案，但不能修改任何文件。规划完成后，方案呈现给用户审批，通过后才进入实现阶段。

**核心理念：** 高风险修改前先对齐方案，避免 AI 跑偏浪费时间和产生不可逆的破坏。

## 2. Plan 模式的触发时机

Claude Code 让 LLM **自主判断**何时需要 plan。判断标准（内建于 system prompt）：

```
EnterPlanMode 应该在以下情况被触发：
1. 新功能实现 — 涉及多个文件
2. 存在多种合理方案 — 需要在实现前做选择
3. 代码修改 — 会影响现有行为和结构
4. 架构决策 — 需要选择模式或技术
5. 涉及 2-3 个以上文件的变更
6. 需求不明确 — 需要探索明确完整范围
7. 用户偏好会影响实现方案

不使用 EnterPlanMode 的情况：
- 单行修复（拼写错误、明显的 bug）
- 需求明确的简单函数添加
- 纯研究/探索任务
```

## 2.5 两种入口：用户手动 vs LLM 自主

Plan 模式有**两个入口**，它们是独立的路径通往相同的状态：

| 入口 | 发起者 | 需要权限确认？ | 自动查询模型？|
|------|--------|:---:|:---:|
| `/plan` (无参数) | 用户 | 否 | 否（仅切换模式）|
| `/plan <描述>` | 用户 | 否 | 是（发送描述给模型）|
| `/plan open` | 用户 | 否 | 否（在外部编辑器打开 plan 文件）|
| `Shift+Tab` 循环模式 | 用户 | 否 | 否 |
| `EnterPlanMode` 工具 | LLM | **是** (需要用户确认) | 是（tool result 返回给模型）|

### 用户手动进入

**`/plan` 命令** — 用户在 prompt 中直接输入 `/plan`：
- **`/plan`**（无参数）→ 立即切换到 plan 模式，不查询模型。终端显示 "Enabled plan mode"
- **`/plan add dark mode`**（带描述）→ 切换模式 + 将描述作为 prompt 发给 LLM
- **`/plan open`** → 在外部编辑器中打开已有 plan 文件

**`Shift+Tab` 循环** — 在 prompt 底部 footer 显示当前模式，用户按 Shift+Tab 在 `default → acceptEdits → plan → auto → default` 之间循环切换。这是最快捷的方式。

### LLM 自主进入

**`EnterPlanMode` 工具** — LLM 判断任务复杂度过高，主动调用该工具：
- ⚠️ **需要用户确认** — 不是静默执行的，会弹出权限确认弹窗
- 通过确认后进入 plan 模式，返回 tool result 告诉 LLM plan 文件路径和探索指引

### 两种退出方式

| 退出方式 | 发起者 | 行为 |
|----------|--------|------|
| `Shift+Tab` 循环 | 用户 | 切换到下一个模式，直接退出（无需审批）|
| `ExitPlanMode` 工具 | LLM | 触发审批对话框，呈现方案，用户审批后才退出 |

两种退出方式都使用 **prePlanMode 恢复**：退出后恢复到进入 plan 之前的模式，而不是写死切回 `default`。

## 3. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                      Plan Mode 架构                           │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   两条入口：                                                  │
│   A. 用户 /plan 命令  ──────────┐                            │
│   B. LLM 调用 EnterPlanMode ───┤                            │
│       │                         ▼                            │
│       │              permissionManager.setMode('plan')       │
│       │              创建 plan 文件 ~/.myclaude/plans/<id>.md│
│       │              注入 plan 专用 attachment               │
│       │                         │                            │
│       │                         ▼                            │
│       │              LLM 进入研究阶段（只读）                 │
│       │                         │                            │
│       │              LLM 探索代码、搜索文件、读取实现         │
│       │                         │                            │
│       │              写方案到 plan 文件                      │
│       │                         │                            │
│       │                         ▼                            │
│       │              LLM 调用 ExitPlanMode 工具               │
│       │              或用户 Shift+Tab 切换退出               │
│       │                         │                            │
│       │                         ▼                            │
│       │              呈现方案给用户审批                       │
│       │                         │                            │
│       │              批准 → 退出 plan 模式                   │
│       │              拒绝 → 继续修改方案                     │
│       │                         │                            │
│       │                         ▼                            │
│       │              LLM 开始实现方案                         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## 4. EnterPlanMode 工具

### 4.1 工具定义

这是 Claude Code 中的特殊工具，像 Bash/Read 一样被 LLM 调用：

```typescript
{
  name: 'EnterPlanMode',
  description: `Use this tool proactively when you're about to start a non-trivial
implementation task. Getting user sign-off on your approach before writing code
prevents wasted effort and ensures alignment.

When to Use: [列出触发条件]

When NOT to Use: [列出排除条件]

What Happens in Plan Mode:
- You'll explore the codebase
- Design an implementation approach
- Present your plan to the user for approval
- Exit plan mode with ExitPlanMode when ready to implement`,
  inputSchema: {},  // 无需参数
  execute: async () => {
    // 1. 切换权限模式
    permissionManager.setMode('plan')
    // 2. 创建 plan 文件
    // 3. 返回指引信息
  }
}
```

### 4.2 EnterPlanMode 执行时发生了什么

**重要：EnterPlanMode 自身也需要用户确认！** 它不是静默执行的，用户会看到一个权限对话框，问是否允许进入 plan 模式。

```
1. LLM 调用 EnterPlanMode
       │
       ▼
2. 用户看到权限确认弹窗: "Enter plan mode?"
       ├─ 批准 → 继续
       └─ 拒绝 → 返回拒绝信息给 LLM
       │
       ▼
3. 保存当前模式 → prePlanMode (用于退出时恢复)
   ├─ 如果之前是 'default' → prePlanMode = 'default'
   ├─ 如果之前是 'auto'    → prePlanMode = 'auto'
   └─ 如果之前是 'acceptEdits' → prePlanMode = 'acceptEdits'

4. 权限模式切换 → 'plan'
   ├─ Bash 被拒绝
   ├─ Write 被拒绝 (plan 文件除外)
   ├─ Edit 被拒绝 (plan 文件除外)
   └─ Read/Glob/Grep 仍然允许

5. 生成 plan 文件路径
   路径: ~/.myclaude/plans/<随机三词-slug>.md
   如: whimsical-questing-sketch.md

6. 返回 Tool Result 给 LLM:
   "Entered plan mode. Plan file: ~/.myclaude/plans/whimsical-questing-sketch.md
    Use Read/Glob/Grep to explore. Write/Edit the plan file with your proposal.
    When ready, call ExitPlanMode."

## 5. Plan 模式期间

### 5.1 System Prompt 注入机制：「Attachments」模式

Claude Code **不替换整个 system prompt**，而是用「附件（Attachment）」机制，在每个 turn 中注入 plan-mode 专用指令。这比替换 system prompt 更灵活：

- **每 turn 注入一次** — 防止 LLM 在长对话中「忘记」自己处于 plan 模式
- **节流优化** — 完整指令每 N turn 显示一次，中间 turn 显示简短提醒
- **上下文压缩安全** — 即使发生 compact（上下文压缩），plan-mode attachment 也会被重新注入

```
Turn 1: [完整 plan_mode attachment — 5 步流程详细说明]
Turn 2: [简短提醒] "Plan mode still active. Read-only except plan file."
Turn 3: [简短提醒] "Plan mode still active..."
...（每 N turn 重复完整指令）
```

### 5.2 Plan-mode Attachment 核心指令（V2 版本）

Claude Code 给 LLM 的是一个 **5 阶段工作流**：

```
Phase 1: Explore with subagents
  → 使用 Agent(Explore) 并行探索相关代码
Phase 2: Design with Plan agents
  → 使用 Agent(Plan) 设计实现方案
Phase 3: Review & Align
  → 审查发现，与用户意图对齐，必要时使用 AskUserQuestion 澄清
Phase 4: Write the final plan
  → 将最终方案写入 plan 文件（唯一可写的文件）
Phase 5: Call ExitPlanMode
  → 调用 ExitPlanMode 呈现方案给用户审批

关键约束: "You MUST NOT make any edits (with the exception of the plan file),
           run any non-readonly tools."
```

**注意：** Phase 1-4 依赖 subagent 机制。对于我们的学习项目，可以简化为：
```
1. Explore codebase yourself (Read/Glob/Grep)
2. Design the approach
3. Write plan to plan file
4. Call ExitPlanMode
```

### 5.3 写操作的特殊处理

在 plan 模式下，LLM 被告知 **plan 文件是唯一可写的文件**：

```typescript
if (this.mode === 'plan') {
  if (toolName === 'Bash') {
    return { decision: 'deny' }
  }
  // Write/Edit 只对 plan 文件放行
  if ((toolName === 'Write' || toolName === 'Edit') &&
      filePath && filePath.includes('/.myclaude/plans/')) {
    return { decision: 'allow' }
  }
  return { decision: 'deny', rule: 'Plan mode' }
}
```

Tool Result 中也会明确告诉 LLM：
```
Plan file: ~/.myclaude/plans/whimsical-questing-sketch.md
This is the ONLY file you may edit in plan mode.
Use Write or Edit to update it with your plan.
```

## 6. ExitPlanMode 工具

### 6.1 工具定义

```typescript
{
  name: 'ExitPlanMode',
  description: `Exit plan mode and present your plan to the user for approval.

After calling this tool, the user will review your plan and either:
- Approve it → plan mode ends, you can start implementing
- Reject it → you may need to revise or abandon the approach`,
  inputSchema: {
    allowedPrompts: z.array(z.object({
      tool: z.enum(['Bash']),
      prompt: z.string().describe('Semantic description of the action')
    })).optional().describe('Prompt-based permissions needed to implement the plan')
  },
  execute: async ({ allowedPrompts }) => {
    // 1. 读取 plan 文件
    // 2. 返回 plan 内容 + 请求用户审批
    // 3. 审批通过 → setMode('default') + 预授权 allowedPrompts
  }
}
```

### 6.2 ExitPlanMode 的 User Approval 流程

```
ExitPlanMode 被调用
    │
    ├─ 1. 读取 ~/.myclaude/plans/<id>.md
    │
    ├─ 2. 呈现 Plan 审批对话框
    │     ┌───────────────────────────────────────────┐
    │     │  Ready to code?                           │
    │     │                                           │
    │     │  ┌─────────────────────────────────────┐  │
    │     │  │  # Add user authentication          │  │
    │     │  │                                     │  │
    │     │  │  ## Context                         │  │
    │     │  │  ... (Markdown 渲染的 plan 内容)     │  │
    │     │  │                                     │  │
    │     │  └─────────────────────────────────────┘  │
    │     │                                           │
    │     │  Approval options:                        │
    │     │  [Yes, clear context & auto]              │
    │     │  [Yes, accept edits, keep context]        │
    │     │  [Yes, keep context & manual approve]     │
    │     │  [No, tell Claude what to change]         │
    │     │                                           │
    │     │  Ctrl+G to edit plan in external editor   │
    │     └───────────────────────────────────────────┘
    │
    ├─ 3. 用户选择:
    │     ├─ "Yes" (含模式选择)
    │     │   → 恢复 prePlanMode (进入 plan 之前的模式)
    │     │   → 如选择了 auto/bypass → 切换到对应模式
    │     │   → plan 文件保留供 LLM 实现时参考
    │     │   → 注入 plan_mode_exit attachment 提醒模型已退出
    │     │
    │     ├─ "No, tell Claude what to change"
    │     │   → 保持在 plan 模式，用户反馈传回 LLM
    │     │   → LLM 根据反馈修改方案
    │     │
    │     └─ Ctrl+G 编辑 plan 文件
    │         → 在外部编辑器中直接修改 plan Markdown
    │         → 修改后的 plan 传回 ExitPlanMode
    │
    └─ 4. 返回 Tool Result 给 LLM
         如果批准: 包含完整 plan 内容（标记"Approved Plan"）
         如果拒绝: 包含用户反馈文本
```

**关键设计：prePlanMode 恢复**
- 退出时不是简单地切回 'default'
- 而是恢复到进入 plan 之前的模式（`prePlanMode`）
- 如果之前是 acceptEdits → 退出后还是 acceptEdits
- 如果之前是 auto → 退出后还是 auto

## 7. Plan 文件管理

### 7.1 文件位置

```
~/.myclaude/
├── plans/
│   ├── whimsical-questing-sketch.md   ← plan 文件
│   └── ...
├── projects/
│   └── <project>/
│       └── <sessionId>.jsonl
└── sessions/
    └── <pid>.json
```

### 7.2 Plan 文件结构

Plan 文件是 LLM 写出来的 Markdown，通常包含：

```markdown
# <Plan Title>

## Context
问题的背景和当前状态

## Design Decisions
架构选择及理由

## Implementation Steps
1. Step 1 — 具体做什么
2. Step 2 — 具体做什么
...

## Verification
如何验证实现是否正确
```

### 7.3 Plan 文件命名

Claude Code 使用**随机形容词-动词-名词**的命名风格（如 `whimsical-questing-sketch.md`），方便通过文件名区分不同 plan。

## 8. 完整交互流程示例

```
User: "Add user authentication to the app"
    │
    ▼
LLM 分析: 复杂任务，涉及多文件，有架构决策 → 调用 EnterPlanMode
    │
    ▼
[System] Plan mode activated. Permissions restricted.
    │
    ▼
LLM → Read: src/server.ts        (allowed)
LLM → Grep: auth pattern         (allowed)
LLM → Read: src/middleware/       (allowed)
LLM → Bash: npm list passport     (DENIED → LLM 被阻断)
    │
    ▼
LLM 意识到不能执行命令，调整策略
LLM → Read: package.json          (allowed)
    │
    ▼
LLM → Write: ~/.myclaude/plans/auth-plan.md
    Plan 内容:
    # Authentication Implementation Plan
    ## Approach: JWT + middleware pattern
    ## Steps: ...
    │
    ▼
LLM → ExitPlanMode
    │
    ▼
[User sees the plan, reviews, clicks Approve]
    │
    ▼
[System] Plan mode exited. Starting implementation...
    │
    ▼
LLM → Write: src/auth/auth.ts     (allowed — not in plan mode)
LLM → Edit: src/server.ts          (allowed)
LLM → Bash: npm install jsonwebtoken (allowed)
...
```

## 9. Plan 模式与其他权限模式的关系

| 模式 | Bash | Write | Edit | Read/Glob/Grep | Plan 文件写入 |
|------|------|-------|------|----------------|--------------|
| default | 询问 | 询问 | 询问 | 自动允许 | N/A |
| plan | **拒绝** | **拒绝** | **拒绝** | 自动允许 | **允许** |
| acceptEdits | 部分允许 | 允许 | 允许 | 自动允许 | N/A |
| auto | 允许 | 允许 | 允许 | 自动允许 | N/A |

Plan 模式的核心差异：Write/Edit 只对 plan 文件网开一面。

## 10. 我们当前的状态与需要做的事

### 已有的基础设施

| 组件 | 状态 | 位置 |
|------|------|------|
| `PermissionMode` 类型含 `'plan'` | ✅ 已有 | `permissions.ts:1` |
| plan 模式下拒绝 Bash/Write/Edit | ✅ 已有 | `permissions.ts:177-181` |
| `permissionManager.setMode()` | ✅ 已有 | `permissions.ts` |
| plan 文件写入的特殊放行 | ❌ 缺失 | `permissions.ts` |

### 需要新建/修改（精简版）

对照真实 Claude Code 源码，以下是针对我们学习项目规模的精简实现方案：

| # | 组件 | 说明 |
|---|------|------|
| 1 | **EnterPlanMode 工具** | 新增到 `tools/index.ts`。调用 `permissionManager.setMode('plan')`，创建 plan 文件，返回 plan 文件路径 |
| 2 | **ExitPlanMode 工具** | 新增到 `tools/index.ts`。读取 plan 文件，触发 plan 审批 dialog，通过后恢复模式 |
| 3 | **Plan mode state** | `AppStateStore.ts` 加 `permissionMode` 字段。`replLauncher.tsx` 中跟踪 prePlanMode |
| 4 | **Plan 文件写入放行** | 修改 `permissions.ts`：plan 模式下 Write/Edit 仅对 plan 文件路径放行 |
| 5 | **Plan 审批 UI** | Plan Approval Dialog — 显示 Markdown plan + Yes/No 选项 |
| 6 | **Plan mode attachment** | 在 query loop 中，plan 模式下每 turn 注入计划模式提醒 |
| 7 | **Plan 文件管理** | `~/.myclaude/plans/<slug>.md` 创建/读取 |
| 8 | **EnterPlanMode 也需要用户确认** | EnterPlanMode 自带权限确认（复用 PermissionConfirm） |

### 简化取舍

| 保留 | 跳过 |
|------|------|
| EnterPlanMode/ExitPlanMode 作为工具 | `allowedPrompts` 预授权参数 |
| prePlanMode 恢复上一模式 | 5 阶段工作流（简化为探索→写方案→退出） |
| Plan 文件唯一可写 | ultraplan / CCR 远程计划 |
| 每 turn plan mode attachment | Subagent 并行探索 |
| 用户审批方案 | Ctrl+G 外部编辑 plan |
| 三词 slug 命名 | 上下文压缩重注入（暂无 compact）|

## 10.5 allowedPrompts 预授权机制

### 问题

Plan 模式退出后进入实现阶段，LLM 需要频繁执行 Bash 命令（`npm test`、`npm install`、`git status`...）。没有预授权的话，用户在方案审批时说「好，去做吧」，然后立刻被每个 Bash 命令打断：

```
🛑 Allow bash: "npm test"?
🛑 Allow bash: "npm install"?
🛑 Allow bash: "git diff"?
... (反复打断，用户体验差)
```

### 解决方案

`allowedPrompts` 是 ExitPlanMode 的一个可选参数，让 LLM 在**提交方案时就声明**实现阶段需要的 Bash 权限类别。用户在审批方案时**一次性授权**这些类别，后续匹配的命令自动放行。

### 机制

**1. LLM 在 ExitPlanMode 中声明需要的权限：**

```typescript
ExitPlanMode({
  allowedPrompts: [
    { tool: "Bash", prompt: "run tests" },
    { tool: "Bash", prompt: "install dependencies" },
  ]
})
```

注意：LLM 写的是**语义描述**（"run tests"），不是具体命令（"npm test"）。语义匹配由 Bash classifier 完成。

**2. `buildPermissionUpdates()` 转换为 allow 规则：**

```typescript
// ExitPlanModePermissionRequest.tsx:120-150
export function buildPermissionUpdates(
  mode: PermissionMode,
  allowedPrompts?: AllowedPrompt[],
): PermissionUpdate[] {
  const updates: PermissionUpdate[] = [
    { type: 'setMode', mode, destination: 'session' },
  ]

  if (isClassifierPermissionsEnabled() && allowedPrompts?.length > 0) {
    updates.push({
      type: 'addRules',
      rules: allowedPrompts.map(p => ({
        toolName: p.tool,
        ruleContent: createPromptRuleContent(p.prompt),
      })),
      behavior: 'allow',
      destination: 'session',
    })
  }

  return updates
}
```

**3. 实现阶段 Bash classifier 自动匹配：**

当 LLM 执行 `npm test` 时，Bash classifier 判断这条命令的语义是否匹配已授权的 "run tests" 类别 → 匹配则自动放行，不弹确认框。

### 架构位置

```
ExitPlanMode 调用
  → checkPermissions: 'ask' → 弹出 Plan Approval Dialog
  → 用户选择审批选项 (auto / acceptEdits / default)
  → buildPermissionUpdates(mode, allowedPrompts)
    → setMode 切换到目标模式
    → addRules 注入 prompt-based allow 规则
  → 实现阶段: Bash classifier 使用这些规则自动放行匹配的命令
```

### 限制

- **Ant-only 特性**：依赖 `isClassifierPermissionsEnabled()`，仅内部版本启用
- 外部 Claude Code 的 `ExitPlanMode` prompt 文件直接去掉了 `allowedPrompts` 的说明（见 `ExitPlanModeTool/prompt.ts` 顶部注释：`Excludes Ant-only allowedPrompts section`）
- 需要 Bash classifier 基础设施做语义匹配，不是简单的字符串比对

### 对我们学习项目的影响

在简化取舍中跳过，因为它依赖：
1. Bash classifier（语义级别的命令分类系统）
2. `isClassifierPermissionsEnabled()` 特性开关
3. `createPromptRuleContent()` 规则内容构建器

这些都是独立的复杂子系统。后续可以作为进阶特性单独实现。

---

## 11. 总结

Plan 模式的本质是 **LLM 自我约束 + 用户决策点**：

```
EnterPlanMode  →  写操作被锁 → LLM 只能研究 → 写方案
    ↓
ExitPlanMode   →  方案呈现给用户 → 用户批准/拒绝
    ↓
实现阶段       →  写操作解锁 → LLM 开始执行方案
```

这个设计解决了 AI 编程助手的核心矛盾：**如何在让 AI 自主行动的同时，保持人对高风险决策的控制权**。

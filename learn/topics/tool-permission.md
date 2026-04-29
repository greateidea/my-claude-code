# Claude Code 工具权限机制深度分析

## 1. 功能名称与定位

Claude Code 的工具权限系统称为 **Permission System**，核心功能是：
- 控制工具调用的执行权限
- 提供用户确认机制 (permission prompts)
- 支持细粒度的规则匹配 (allow/ask/deny)
- 支持多种权限模式 (default, acceptEdits, plan, auto, dontAsk, bypassPermissions)

## 2. 核心入口与调用链

### 主要文件
- `src/services/permissions/permissions.ts` - 权限检查核心
- `src/services/permissions/rules.ts` - 规则匹配逻辑
- `src/services/tools/toolOrchestration.ts` - 工具编排（集成权限检查）
- `src/services/tools/toolExecution.ts` - 单工具执行

### 调用链
```
工具调用请求
    ↓
toolOrchestration.runToolUse()
    ↓
permissions.checkPermission()
    ↓
    ├─ 匹配 deny 规则 → decision: "deny"
    ├─ 匹配 allow 规则 → decision: "allow"
    ├─ 匹配 ask 规则  → decision: "ask"
    └─ 无匹配         → decision: "ask" (默认)
    ↓
根据 decision 处理:
    ├─ "allow"  → 直接执行
    ├─ "deny"   → 返回错误
    └─ "ask"    → 显示权限确认 UI
```

## 3. 权限检查核心流程

### 3.1 checkPermission 函数

```typescript
// settings.ts:checkPermission()
checkPermission(toolName: string, toolInput: unknown): PermissionCheckResult {
  // 1. 检查是否是 ACP 工具
  if (!toolName.startsWith(ACP_TOOL_NAME_PREFIX)) {
    return { decision: "ask" }
  }

  const permissions = this.mergedSettings.permissions
  if (!permissions) {
    return { decision: "ask" }
  }

  // 2. 优先检查 deny 规则
  for (const rule of permissions.deny || []) {
    const parsed = parseRule(rule)
    if (matchesRule(parsed, toolName, toolInput, this.cwd)) {
      return { decision: "deny", rule, source: "deny" }
    }
  }

  // 3. 检查 allow 规则
  for (const rule of permissions.allow || []) {
    const parsed = parseRule(rule)
    if (matchesRule(parsed, toolName, toolInput, this.cwd)) {
      return { decision: "allow", rule, source: "allow" }
    }
  }

  // 4. 检查 ask 规则
  for (const rule of permissions.ask || []) {
    const parsed = parseRule(rule)
    if (matchesRule(parsed, toolName, toolInput, this.cwd)) {
      return { decision: "ask", rule, source: "ask" }
    }
  }

  // 5. 默认 ask
  return { decision: "ask" }
}
```

### 3.2 决策优先级

```
deny → ask → allow
```

- **deny 规则优先级最高**：一旦匹配，直接拒绝
- **allow 规则次之**：匹配后允许执行
- **ask 规则**：需要用户确认
- **默认 ask**：无规则匹配时询问用户

## 4. 权限模式 (Permission Modes)

| Mode | Description |
|------|-------------|
| `default` | 标准行为：首次使用每个工具时提示 |
| `acceptEdits` | 自动接受文件编辑和常见文件系统命令 |
| `plan` | 计划模式：只能分析，不能修改文件或执行命令 |
| `auto` | 自动批准，带后台安全检查 (实验预览) |
| `dontAsk` | 自动拒绝，除非有 pre-approved 规则 |
| `bypassPermissions` | 跳过权限提示，除了保护目录 (警告!) |

### 模式切换逻辑

```typescript
// 权限模式检查在 Tool.ts 的 checkPermissions 方法
checkPermissions(
  input: z.infer<Input>,
  context: ToolUseContext,
): Promise<PermissionResult> {
  // 检查当前权限模式
  const mode = context.mode

  // acceptEdits 模式下自动允许编辑操作
  if (mode === 'acceptEdits' && this.isFileEditTool) {
    return { allowed: true }
  }

  // plan 模式下拒绝所有写操作
  if (mode === 'plan' && this.isWriteTool) {
    return { allowed: false, reason: 'Plan mode prevents file modifications' }
  }
}
```

## 5. 规则匹配机制

### 5.1 规则格式

```
Tool
Tool(specifier)
Tool(wildcard*)
```

### 5.2 工具特定规则

#### Bash 规则
- `Bash` - 匹配所有 bash 命令
- `Bash(npm run build)` - 精确匹配
- `Bash(npm *)` - 通配符匹配
- `Bash(git commit *)` - 前缀匹配

#### Read/Edit 规则
- `Read` - 匹配所有读取
- `Read(./.env)` - 精确路径
- `Edit(/src/**/*.ts)` - glob 模式

#### WebFetch 规则
- `WebFetch(domain:example.com)` - 域名匹配

#### MCP 规则
- `mcp__puppeteer` - MCP 服务器所有工具
- `mcp__puppeteer__navigate` - 特定工具

### 5.3 规则解析

```typescript
// rules.ts parseRule()
function parseRule(rule: string): ParsedRule {
  // 解析 "Tool(specifier)" 格式
  const match = rule.match(/^(\w+)\((.*)\)$/)
  if (match) {
    return { tool: match[1], specifier: match[2] }
  }
  return { tool: rule, specifier: null }
}

// matchesRule() 核心匹配逻辑
function matchesRule(
  parsed: ParsedRule,
  toolName: string,
  toolInput: unknown,
  cwd: string
): boolean {
  // 1. 工具名匹配
  if (!toolName.startsWith(parsed.tool)) return false

  // 2. specifier 匹配
  if (!parsed.specifier) return true

  // 3. 根据工具类型调用特定匹配逻辑
  if (parsed.tool === 'Bash') {
    return matchBashRule(parsed.specifier, toolInput.command)
  }
  if (parsed.tool === 'Read' || parsed.tool === 'Edit') {
    return matchPathRule(parsed.specifier, toolInput.filePath, cwd)
  }
  // ... 其他工具类型
}
```

## 6. 只读工具自动放行

Claude Code 识别一组内置的只读命令，无需权限提示：

```typescript
// 识别只读 Bash 命令
const READONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc',
  'diff', 'stat', 'du', 'cd', 'git status', 'git log',
  // ... 更多只读命令
])

function isReadOnlyCommand(command: string): boolean {
  const baseCmd = command.split(/[;&|]/)[0].trim().split(' ')[0]
  return READONLY_COMMANDS.has(baseCmd)
}
```

- Read-only 工具（Read, Glob, Grep）无需提示
- 只读 Bash 命令（ls, cat, git status 等）无需提示
- `cd` 到工作目录内的路径无需提示

## 7. 权限确认 UI 流程

### 7.1 权限请求结构

```typescript
interface PermissionRequest {
  toolName: string
  toolInput: Record<string, any>
  title: string           // 例如 "Edit src/auth.py"
  description: string     // 序列化的工具输入
  options: PermissionOption[]
}

interface PermissionOption {
  optionId: string
  name: string           // "Allow once", "Allow always", etc.
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}
```

### 7.2 用户交互选项

| Option | Effect |
|--------|--------|
| Allow once | 本次会话允许一次 |
| Allow always | 永久允许（写入 settings.json） |
| Reject once | 本次拒绝一次 |
| Reject always | 永久拒绝（写入 settings.json） |

### 7.3 UI 显示内容

```
┌─────────────────────────────────────────────────────┐
│  [Tool Icon]  Bash: npm run build                   │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Command: npm run build                             │
│  Working directory: /project                       │
│                                                     │
├─────────────────────────────────────────────────────┤
│  [Allow once]  [Allow always]  [Reject once]  [X]  │
└─────────────────────────────────────────────────────┘
```

## 8. 权限状态管理

### 8.1 内存中的权限状态

```typescript
interface PermissionState {
  // 当前权限模式
  mode: PermissionMode

  // 本次会话的临时允许列表
  sessionAllowed: Set<string>

  // 本次会话的临时拒绝列表
  sessionDenied: Set<string>
}
```

### 8.2 持久化规则

用户选择 "Allow always" 或 "Reject always" 时，规则写入：

```json
{
  "permissions": {
    "allow": ["Bash(npm run build)", "Read(/src/**)"],
    "deny": ["Bash(rm -rf *)"]
  }
}
```

文件位置：`~/.claude/settings.json` 或项目 `.claude/settings.json`

## 9. 工具集成点

### 9.1 Tool.ts 接口

```typescript
// Tool.ts - 每个工具可覆盖的权限检查
class Tool {
  // 工具特定权限检查逻辑
  async checkPermissions(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<PermissionResult> {
    // 默认：允许执行，后续由 orchestration 统一检查
    return { allowed: true }
  }

  // 可选：提供权限匹配器
  async preparePermissionMatcher(
    input: z.infer<Input>,
  ): Promise<(pattern: string) => boolean> {
    return () => false
  }
}
```

### 9.2 toolOrchestration 集成

```typescript
// toolOrchestration.ts - 执行前检查权限
async function runToolUse(toolUse: ToolUseBlock, context) {
  const { decision, rule, source } = context.settings.checkPermission(
    toolUse.name,
    toolUse.input
  )

  if (decision === 'deny') {
    return {
      type: 'error',
      error: `Tool denied by rule: ${rule}`,
    }
  }

  if (decision === 'ask') {
    // 等待用户确认
    const result = await promptUserPermission(toolUse, context)
    if (!result.allowed) {
      return { type: 'error', error: result.reason }
    }
  }

  // 执行工具
  return await executeTool(toolUse, context)
}
```

## 10. 边界情况处理

### 10.1 复合命令

```typescript
// 用户允许 "git status && npm test"
// 系统保存为两条独立规则：
// - "Bash(npm test)"
// - "Read(<path>)" for the cd
```

### 10.2 进程包装器

自动剥离常见包装器：`timeout`, `time`, `nice`, `nohup`, `stdbuf`, `xargs`

```
timeout 30 npm test  →  匹配 Bash(npm test *)
```

### 10.3 符号链接

- **Allow**: 检查 symlink 和 target 都匹配才允许
- **Deny**: symlink 或 target 任一匹配即拒绝

### 10.4 保护目录

即使 `bypassPermissions` 模式下，以下目录仍需确认：
- `.git`, `.vscode`, `.idea`, `.husky`

## 11. 设计决策

### 11.1 为什么 deny 优先？

安全原则：拒绝比允许更容易控制。deny 规则一旦匹配立即阻止，不可被 override。

### 11.2 为什么区分 "once" 和 "always"？

- "once": 临时允许，当前会话有效
- "always": 持久化到 settings，减少未来提示

### 11.3 为什么限制 always 规则数量？

防止用户意外添加过多规则导致权限失控。Claude Code 建议限制在关键命令。

## 12. 与我们的实现对比

| 方面 | Claude Code | 我们的实现 (当前) |
|------|-------------|-----------------|
| 权限检查点 | 工具执行前统一检查 | 无 |
| 规则匹配 | 完整规则语法 | 无 |
| 权限模式 | 6 种模式 | 无 |
| UI 确认 | 弹窗确认 | 无 |
| 持久化 | settings.json | 无 |
| 会话状态 | sessionAllowed/Denied | 无 |

## 13. 总结

Claude Code 的权限系统核心设计：

1. **三层决策**：deny → ask → allow，首个匹配决定结果
2. **工具无关的统一检查点**：在 toolOrchestration 层统一拦截
3. **细粒度规则**：支持通配符、路径匹配、域名匹配
4. **模式切换**：支持不同权限模式适应不同场景
5. **持久化**：allow/deny 规则写入配置文件
6. **保护目录**：即使 bypass 模式也保护关键目录

这解释了为什么 Bash 命令需要确认，而 Read 不需要；以及规则如何从临时 "once" 变为永久 "always"。
# Thinking 思考机制架构分析

基于 Claude Code 官方源码的深入分析，涵盖完整的 thinking/reasoning 处理链路。

---

## 1. 架构总览

Claude Code 的 thinking 体系分为 7 个层次：

```
┌─────────────────────────────────────────────────────────┐
│ 1. Configuration Layer   ThinkingConfig 类型 + 设置      │
├─────────────────────────────────────────────────────────┤
│ 2. Model Capability      modelSupportsThinking()        │
├─────────────────────────────────────────────────────────┤
│ 3. API Request           thinking 参数 + redact header   │
├─────────────────────────────────────────────────────────┤
│ 4. Streaming             content_block_start/thinking    │
│                          → thinking_delta → completed    │
├─────────────────────────────────────────────────────────┤
│ 5. Message Normalization filterOrphaned, filterTrailing  │
├─────────────────────────────────────────────────────────┤
│ 6. State Management      thinkingEnabled, streaming-    │
│                          Thinking, hidePastThinking      │
├─────────────────────────────────────────────────────────┤
│ 7. UI Rendering          AssistantThinkingMessage,       │
│                          ThinkingToggle, verbose mode    │
└─────────────────────────────────────────────────────────┘
```

---

## 2. 配置层 (Configuration Layer)

### 2.1 ThinkingConfig 类型

```typescript
// src/utils/thinking.ts
export type ThinkingConfig =
  | { type: 'adaptive' }           // 模型自适应
  | { type: 'enabled'; budgetTokens: number }  // 固定预算
  | { type: 'disabled' }           // 关闭
```

三种模式：
- **adaptive**: Claude 4.6+ 支持，模型自行决定何时以及思考多少
- **enabled**: 旧模型使用，固定 token 预算，由 `budgetTokens` 控制
- **disabled**: 不启用思考

### 2.2 能力检测

```typescript
// 模型是否支持 thinking
function modelSupportsThinking(model: string): boolean {
  // 1P/Foundry: 所有 Claude 4+ 模型支持 (排除 claude-3-)
  // 3P (Bedrock/Vertex): 仅 sonnet-4, opus-4 支持
}

// 模型是否支持自适应思考
function modelSupportsAdaptiveThinking(model: string): boolean {
  // opus-4-6, sonnet-4-6 支持
  // 未知模型在 1P 上默认 true
}
```

### 2.3 默认启用策略

```typescript
function shouldEnableThinkingByDefault(): boolean {
  // 1. 检查 MAX_THINKING_TOKENS 环境变量
  // 2. 检查 settings.alwaysThinkingEnabled
  // 3. 默认 true
}
```

### 2.4 用户设置

| 设置项 | 类型 | 说明 |
|--------|------|------|
| `alwaysThinkingEnabled` | boolean | 全局关闭 thinking |
| `showThinkingSummaries` | boolean | 在 transcript 视图中显示摘要 |
| `MAX_THINKING_TOKENS` | env | 最大 thinking token 数 |

---

## 3. API 请求层 (API Request Layer)

### 3.1 Anthropic API 调用

```typescript
// src/services/api/claude.ts - queryModel()

// 1. 判断是否启用
const hasThinking =
  thinkingConfig?.type !== 'disabled' &&
  !isThinkingDisabled &&
  modelSupportsThinking(model)

// 2. 构造 thinking 参数
if (modelSupportsAdaptiveThinking(model)) {
  thinking = { type: 'adaptive' }
} else {
  const budgetTokens = thinkingConfig.type === 'enabled'
    ? thinkingConfig.budgetTokens
    : getMaxThinkingTokensForModel(model)
  thinking = { type: 'enabled', budget_tokens: budgetTokens }
}

// 3. 发送给 API
const params = {
  model,
  messages,
  thinking,  // ← 顶层参数
  temperature: undefined,  // thinking 时必须用默认 temperature
}
```

### 3.2 Redacted Thinking (脱敏)

通过 beta header `redact-thinking-2026-02-12` 让 API 服务端加密 thinking 内容：
- 正常 thinking block → `signature_delta` 事件
- Redacted thinking → `redacted_thinking` block，内容为加密签名

### 3.3 Context Management 中的 Thinking

```typescript
// 上下文管理策略
if (thinkingActive && !isRedactThinkingActive) {
  strategies.push({ type: 'clear_thinking_20251015' })
}

// cleanAllThinking: 只保留最后一轮 thinking
// 否则: 保留所有 thinking
```

---

## 4. 流式处理层 (Streaming Layer)

### 4.1 事件流转

```
API Stream
  │
  ├── content_block_start { type: 'thinking' }
  │     → 设置 spinner mode = 'thinking'
  │
  ├── thinking_delta { thinking: '...' }
  │     → 累积到 streamingThinking.thinking
  │     → 增加 output token 计数
  │
  ├── signature_delta { signature: '...' }
  │     → 排除在 token 计数外（加密数据，非模型产出）
  │
  └── content_block_stop
        → streamingEndedAt = timestamp
        → isStreaming = false
```

### 4.2 StreamingThinking 类型

```typescript
type StreamingThinking = {
  thinking: string
  isStreaming: boolean
  streamingEndedAt?: number
}
```

### 4.3 OpenAI 适配 (3P providers)

```
src/services/api/openai/streamAdapter.ts
  delta.reasoning_content     ← DeepSeek/Qwen 的思考字段
       │
       ▼ 转换为 Anthropic 格式
  content_block_start { type: 'thinking' }
  thinking_delta { thinking: '...' }
  text_delta { text: '...' }           ← 切换到正文时自动关闭 thinking block
```

关键逻辑：当检测到 text 或 tool_call delta 时，先 `content_block_stop` 关闭 thinking block，再开始新的 text/tool block。

---

## 5. 消息规范化层 (Normalization Layer)

### 5.1 Trailing Thinking 过滤

```typescript
function filterTrailingThinkingFromLastAssistant(messages: Message[]): Message[] {
  // API 不允许 assistant message 以 thinking block 结尾
  // 移除末尾的 thinking blocks
  // 如果所有 blocks 都是 thinking，插入占位 "[No message content]"
}
```

### 5.2 Orphaned Thinking 过滤

```typescript
function filterOrphanedThinkingOnlyMessages(messages: Message[]): Message[] {
  // Streaming 期间，每个 content_block 产生独立 message
  // 如果用户消息穿插，导致 thinking-only message 未被合并
  // 检测并移除这些孤儿 thinking message
}
```

### 5.3 Thinking 类型守卫

```typescript
function isThinkingBlock(block): boolean {
  return block.type === 'thinking' || block.type === 'redacted_thinking'
}

function isThinkingMessage(message): boolean {
  return message.content.every(block => isThinkingBlock(block))
}
```

---

## 6. UI 渲染层 (UI Rendering)

### 6.1 显示策略

| 模式 | Thinking 行为 |
|------|--------------|
| **Prompt 模式 (默认)** | 全部隐藏，仅显示 "∴ Thinking (Ctrl+O to expand)" |
| **Transcript 模式 (Ctrl+O)** | 只显示最后一个 assistant 的 thinking，旧的隐藏 |
| **Verbose 模式** | 全部展开显示 |

### 6.2 AssistantThinkingMessage 组件

```
┌─ ∴ Thinking ─────────────────────┐
│   用户的问题涉及数学计算...        │  ← dim italic, Markdown 渲染
│   1. 拆分表达式                    │
│   2. 逐步计算                      │
│   3. 验证结果                      │
└──────────────────────────────────┘
```

- 非展开状态: `"∴ Thinking (Ctrl+O to expand)"`，简短提示
- 展开状态: 完整 thinking 内容，dim 样式，2 空格缩进
- 使用 Markdown 渲染器处理格式化

### 6.3 AssistantRedactedThinkingMessage 组件

```
✻ Thinking...
```

- 简单占位符，thinking 内容已被服务端加密，无法显示
- 用于 `redact-thinking` beta 模式

### 6.4 ThinkingToggle 组件

允许用户中途切换 thinking 开关的对话框。通过 bridge 或 UI 触发。

### 6.5 Streaming Thinking 展示

```typescript
// Messages.tsx 中
lastThinkingBlockId 计算逻辑:
  1. 从最新消息倒序遍历
  2. 找到最后一个有 thinking block 的 assistant message
  3. 如果该 message 的 streaming thinking 仍在进行，返回 'streaming'
  4. 遇到 user message（非 tool_result），返回 'no-thinking'（隐藏旧 thinking）
```

### 6.6 hidePastThinking 机制

```typescript
// REPL.tsx - transcript 模式
hidePastThinking = true

// Messages.tsx
const lastThinkingBlockId = computeLastThinkingBlockId()
// 只 render match lastThinkingBlockId 的 thinking block
// 其他 block: hideInTranscript = true → return null
```

---

## 7. 状态管理层 (State Management)

### 7.1 AppState 中的 thinkingEnabled

```typescript
// state/AppStateStore.ts
interface AppState {
  thinkingEnabled: boolean | undefined  // undefined = 使用默认值
}
```

- 初始化: `shouldEnableThinkingByDefault()`
- 可通过 `settings.alwaysThinkingEnabled` 同步
- 可通过 bridge `set_max_thinking_tokens` 远程调整

### 7.2 REPL 本地状态

```typescript
// components/screens/REPL.tsx
const [streamingThinking, setStreamingThinking] = useState<StreamingThinking | null>(null)
const [hidePastThinking, setHidePastThinking] = useState(false)

// 30 秒后自动清除已完成的 streaming thinking
useEffect(() => {
  if (streamingThinking?.streamingEndedAt) {
    const timer = setTimeout(() => setStreamingThinking(null), 30000)
    return () => clearTimeout(timer)
  }
}, [streamingThinking])
```

### 7.3 Bootstrap 缓存

```typescript
// bootstrap/state.ts
let thinkingClearLatched: boolean | null = null

// 一次设置后保持为 true（避免 thinking 清理缓存失效）
function getThinkingClearLatched(): boolean {
  if (thinkingClearLatched === null) {
    thinkingClearLatched = (timeSinceLastApiCall > 1 hour)
  }
  return thinkingClearLatched
}
```

---

## 8. 跨 Provider 支持

### 8.1 OpenAI → Anthropic 映射

```typescript
// openai/streamAdapter.ts
// DeepSeek/Qwen 的 reasoning_content → Anthropic thinking format

delta.reasoning_content  → content_block_start { type: 'thinking' }
                         → thinking_delta { thinking: '...' }

delta.content            → 先 content_block_stop thinking
                         → content_block_start { type: 'text' }
                         → text_delta { text: '...' }
```

### 8.2 反向映射 (Anthropic → OpenAI)

```typescript
// openai/convertMessages.ts
// 转换为 OpenAI 格式时，直接丢弃 thinking blocks
// (OpenAI API 不支持 thinking content blocks)
```

---

## 9. Compact / Token 计数

```typescript
// thinking block 的 token 计算
if (block.type === 'thinking') {
  tokens += countTokens(block.thinking)
} else if (block.type === 'redacted_thinking') {
  tokens += countTokens(block.data)  // 加密签名的长度
}
```

---

## 10. Ultrathink 特性

特殊的 `ultrathink` 关键词触发功能：
- 用户在输入中包含 `ultrathink` 关键词
- 通过 `hasUltrathinkKeyword()` 检测
- UI 中用彩虹色高亮该词（`HighlightedThinkingText` 组件）
- 由 feature flag `ULTRATHINK` + GrowthBook `tengu_turtle_carbon` 控制

---

## 11. 与当前项目的差距分析

| 维度 | Claude Code | 当前项目 | 差距 |
|------|------------|---------|------|
| **Thinking 配置** | ThinkingConfig 三模式 | 无配置，仅 prompt 引导 | 需要添加配置类型 |
| **API 层** | Anthropic `thinking` 参数 | 无 API 参数 | NVIDIA API 支持 reasoning_content |
| **流式处理** | content_block_start/delta | streamChat 已实现但未启用 | 启用 streaming 即可 |
| **解析方式** | SDK 原生事件 + reasoning_content 适配 | 正则提取 `<thinking>` XML | 应优先使用 reasoning_content |
| **UI 组件** | AssistantThinkingMessage (toggle/expand) | 简单的 "💭 Thinking:" | 需要独立的 Thinking 组件 |
| **显示模式** | 3 种模式 (prompt/transcript/verbose) | 1 种模式 (始终显示) | 至少增加折叠/展开 |
| **Message 类型** | thinking 是 content block 类型 | 无 thinking 字段 | 添加 thinking 到 Message |
| **状态管理** | thinkingEnabled + streamingThinking | thinkingContent (临时) | 添加完整状态 |
| **用户控制** | ThinkingToggle + settings | 无 | 暂不需要，先做基础 |
| **规范化** | filterOrphaned, filterTrailing | 无 | 当前规模不需要 |

---

## 12. 当前项目应如何调整

### 12.1 核心思路

当前项目使用 NVIDIA API (OpenAI 兼容接口) 调用 qwen 模型（模型名含 "thinking"）。这个模型在流式模式下可能返回 `reasoning_content`。应同时支持两种 thinking 来源：

1. **优先**: 流式 API 的 `reasoning_content`（模型原生支持）
2. **兜底**: Prompt 引导的 `<thinking>` XML 标签（非流式或模型不支持时）

### 12.2 具体调整项

1. **启用 streaming mode** — 让 `DeepSeekClient.streamChat()` 运转起来
2. **添加 ThinkingConfig 类型** — 控制 thinking 行为
3. **创建 ThinkingMessage 组件** — 独立展示 thinking，支持折叠/展开
4. **Message 类型扩展** — 添加 `thinking?: string` 字段
5. **优化 REPL** — 思考与正文更清晰的视觉分离
6. **保留 XML 提取** — 作为兜底方案

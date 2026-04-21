# Thinking 思考机制详解

## 1. API 层面的支持

Claude Code 使用 **Anthropic 官方 API** 的 thinking 参数：

```typescript
// thinking 配置类型
type ThinkingConfig = 
  | { type: 'adaptive' }      // 自适应思考
  | { type: 'enabled'; budgetTokens: number }  // 固定 token 预算
  | { type: 'disabled' }     // 禁用

// API 调用时传递
{
  thinking: {
    type: 'enabled',
    budget_tokens: 1024  // 思考预算 tokens
  }
}
```

### Thinking Budget

```typescript
const hasThinking = 
  thinkingConfig.type !== 'disabled' && 
  modelSupportsThinking(model)

if (modelSupportsAdaptiveThinking(model)) {
  thinking = { type: 'adaptive' }
} else {
  thinking = { 
    type: 'enabled', 
    budget_tokens: getMaxThinkingTokensForModel(model) 
  }
}
```

---

## 2. Stream 处理

模型返回 thinking 时，通过 stream 事件处理：

```typescript
// Anthropic SDK stream 事件
case 'thinking_delta':
  yield { 
    type: 'content_block_delta', 
    delta: { type: 'thinking_delta', thinking: '...' } 
  }
```

---

## 3. Thinking 配置模式

```typescript
type ThinkingConfig =
  | { type: 'disabled' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'adaptive' }

// API 调用
{
  thinking: { type: 'adaptive' }
}
```

---

## 4. Interleaved Thinking（交错思考）

允许在思考过程中交错执行工具：

```typescript
modelSupportsISP('claude-4-sonnet')  // true
modelSupportsISP('claude-3-5-sonnet') // false
```

---

## 5. Redacted Thinking（脱敏思考）

用签名加密 thinking 内容，不暴露给用户但保留用于上下文：

```typescript
{
  type: 'redacted_thinking',
  thinking: 'encrypted_signature_here'
}
```

---

## 6. 非 Anthropic 模型如何支持 Thinking

### 6.1 核心问题

Anthropic 官方 API 的 `thinking` 参数只适用于 Anthropic 模型。如果使用第三方模型（如 Qwen、DeepSeek），需要自己实现 thinking 机制。

### 6.2 XML Thinking 方案

通过 System Prompt 引导模型输出 thinking：

```typescript
const THINKING_INSTRUCTION = `
IMPORTANT: When you need to think through a problem, wrap your reasoning in <thinking> tags:

<thinking>
Your step-by-step reasoning goes here...
</thinking>

Then provide your final answer.
`

const content = `
<thinking>
To solve 123 * 456:
1. 123 * 456 = 123 * (400 + 50 + 6)
2. = 49200 + 6150 + 738
3. = 56088
</thinking>
The answer is 56088.
`
```

### 6.3 解析实现

```typescript
const THINKING_REGEX = /<thinking>([\s\S]*?)<\/thinking>/gi

function extractThinkingContent(content: string): string | null {
  const match = THINKING_REGEX.exec(content)
  return match[1]?.trim() ?? null
}

function stripThinkingContent(content: string): string {
  return content.replace(THINKING_REGEX, '').trim()
}
```

---

## 7. 关键澄清：环境变量不能改变模型行为

### 常见误解

**误解**: 配置 `ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES=thinking` 后，DeepSeek 模型就会自动输出 thinking 内容。

**事实**: 环境变量只是**声明/配置**，不会改变模型本身的行为！

### 正确的理解流程

```
配置环境变量
    │
    ▼
modelSupportsThinking('deepseek/deepseek-chat') 返回 true
    │
    ▼
API 请求添加 thinking: { type: 'adaptive' }
    │
    ▼
DeepSeek API 不识别 thinking 参数 → 被忽略
    │
    ▼
模型响应: 没有 reasoning_content 字段
    │
    ▼
结果: 仍然没有 thinking 输出！
```

### 环境变量的真正作用

| 环境变量 | 作用 |
|---------|------|
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | 声明使用的模型名称 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES` | 声明模型支持的能力 |

它们只是**告诉 Claude Code 这个模型的"能力声明"**，而不是"让模型获得能力"。

### 各模型支持的真相

| 模型 | 原生支持 reasoning_content？ | 环境变量能否改变？ |
|------|---------------------|--------------|
| Claude 4+ (Anthropic) | ✅ 是 | 不需要 |
| DeepSeek | ❌ 否 | ❌ 不能 |
| Qwen | ❌ 否 | ❌ 不能 |
| OpenAI o1/o3 | ✅ 是 | 不需要 |

---

## 8. 我们的实现代码

```typescript
// src/services/queryLoop.ts

export interface QueryStep {
  type: 'message' | 'tool' | 'error' | 'thinking'
  content?: string
}

// 在 QueryLoop 中处理
const rawContent = response.message.content ?? ''
const thinking = extractThinkingContent(rawContent)

if (thinking) {
  yield { type: 'thinking', content: thinking }
}

const content = stripThinkingContent(rawContent)
yield { type: 'message', content }
```

### 测试结果

```
# 运行: bun run tests/test-thinking.ts

User: What is 123 * 456?

💭 Thinking: To solve the problem 123 * 456, I will multiply:
1. 123 * 6 = 738
2. 123 * 5 = 6150
3. 123 * 4 = 49200
4. Add: 738 + 6150 + 49200 = 56088

📝 Message: =calculate(expression=738+6150+49200)
```

---

## 9. 总结

### Thinking 机制全景图

| 层面 | 实现方式 | 关键代码 |
|------|----------|----------|
| **Provider 判断** | 环境变量 / settings | `getAPIProvider()` |
| **Thinking 配置** | API 参数 | `{ thinking: { type: 'adaptive' } }` |
| **Stream 处理** | 事件解析 | `thinking_delta` 事件 |
| **格式转换** | Adapter | `reasoning_content` → `thinking` |
| **脱敏** | 加密签名 | `redacted_thinking` |
| **能力检测** | 模型白名单 | `modelSupportsThinking()` |
| **纯文本模型** | Prompt 引导 + 正则 | `<thinking>...</thinking>` |

### 真正让模型输出 thinking 的方式

- **Anthropic 官方模型** → API `thinking` 参数
- **OpenAI o1/DeepSeek** → Stream `reasoning_content` 字段
- **其他模型** → Prompt 引导 + 正则解析

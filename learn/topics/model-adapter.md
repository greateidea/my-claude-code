# 模型调用与适配机制

## 1. API Provider 体系

Claude Code 支持多种 API 提供商，通过 `getAPIProvider()` 判断：

```typescript
type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'openai'

function getAPIProvider(): APIProvider {
  const modelType = getInitialSettings().modelType
  if (modelType === 'openai') return 'openai'
  
  if (process.env.CLAUDE_CODE_USE_OPENAI) return 'openai'
  if (process.env.CLAUDE_CODE_USE_BEDROCK) return 'bedrock'
  if (process.env.CLAUDE_CODE_USE_VERTEX) return 'vertex'
  if (process.env.CLAUDE_CODE_USE_FOUNDRY) return 'foundry'
  
  return 'firstParty'
}
```

---

## 2. Claude Code 如何调用第三方模型

### 核心工具：OpenAI SDK

Claude Code 使用 **`openai` npm 包**作为统一接口来调用第三方模型：

```typescript
import OpenAI from 'openai'

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
})
```

### 为什么选择 OpenAI SDK？

**OpenAI API 已成为行业标准**，多数 LLM 提供商都兼容：

| 提供商 | 是否兼容 | Base URL 示例 |
|--------|---------|--------------|
| OpenAI | ✅ | api.openai.com/v1 |
| DeepSeek | ✅ | api.deepseek.com/v1 |
| Azure OpenAI | ✅ | *.azure.com |
| Ollama | ✅ | localhost:11434/v1 |
| NVIDIA NIM | ✅ | integrate.api.nvidia.com/v1 |
| Anthropic | ❌ | 有专门适配器 |

---

## 3. 调用链详解

```
用户请求
    │
    ▼
检测: getAPIProvider() === 'openai'
    │
    ▼
queryModelOpenAI() 入口函数
    │
    ├─ resolveOpenAIModel()      映射模型名
    ├─ anthropicMessagesToOpenAI()  转换消息格式
    ├─ anthropicToolsToOpenAI()    转换工具定义
    │
    ▼
client.chat.completions.create()  调用 OpenAI API
    │
    ▼
adaptOpenAIStreamToAnthropic()  适配响应格式
    │
    ▼
产出 Anthropic 兼容的事件流
```

### 关键代码

```typescript
// src/services/api/openai/index.ts
export async function* queryModelOpenAI(...) {
  const client = getOpenAIClient({...})
  
  const stream = await client.chat.completions.create({
    model: openaiModel,
    messages: openaiMessages,
    tools: openaiTools,
    stream: true,
  })

  const adaptedStream = adaptOpenAIStreamToAnthropic(stream, openaiModel)
  
  for await (const event of adaptedStream) {
    yield event
  }
}
```

---

## 4. Stream 适配器详解

### 为什么需要 Stream 适配

不同的 AI 提供商使用不同的流式响应格式：

| 提供商 | 思考内容字段 | 流式事件结构 |
|--------|-------------|-------------|
| **Anthropic** | `thinking_delta` 事件 | 独立事件流 |
| **OpenAI/DeepSeek** | `reasoning_content` | 与 `content` 并行在 delta 中 |

### 源格式 (OpenAI/DeepSeek)

```json
// 第一个 chunk
{
  "choices": [{
    "delta": {
      "reasoning_content": "Let me",
      "content": ""
    }
  }]
}

// 第二个 chunk
{
  "choices": [{
    "delta": {
      "reasoning_content": " think about this",
      "content": ""
    }
  }]
}

// 第三个 chunk (思考结束，回答开始)
{
  "choices": [{
    "delta": {
      "reasoning_content": " step by step.",
      "content": "The answer is"
    }
  }]
}
```

### 目标格式 (Anthropic Beta)

```
1. message_start
2. content_block_start(type: 'thinking')
3. content_block_delta(type: 'thinking_delta', thinking: 'Let me')
4. content_block_delta(type: 'thinking_delta', thinking: ' think about this')
5. content_block_stop
6. content_block_start(type: 'text')
7. content_block_delta(type: 'text_delta', text: 'The answer is')
8. message_delta(stop_reason: 'end_turn')
9. message_stop
```

---

## 5. 思考增量 (Thinking Delta) 详解

### 什么是 Delta？

Delta 即"增量"，表示流式响应中每一块新增加的内容：

```typescript
// 非流式 (一次性完整返回)
{ "content": "The answer is 42. Let me explain..." }

// 流式 (分块返回)
Chunk 1: { "content": "The" }
Chunk 2: { "content": " answer" }
Chunk 3: { "content": " is 42." }
Chunk 4: { "content": " Let me" }
Chunk 5: { "content": " explain..." }
```

### Thinking Delta 的特殊之处

Thinking 和 Content 是**两个并行的流**，同时传输：

```
Thinking 流: "Let me" → " think" → " about" → " this" → ...
Content 流:          "" → "" → "" → "The" → " answer" → " is" → ...
```

---

## 6. 模型能力检测

### 三层检测机制

```typescript
function modelSupportsThinking(model: string): boolean {
  // Layer 1: 3rd party override
  const supported3P = get3PModelCapabilityOverride(model, 'thinking')
  if (supported3P !== undefined) return supported3P

  // Layer 2: Anthropic 内置模型
  if (process.env.USER_TYPE === 'ant') {
    if (resolveAntModel(model.toLowerCase())) return true
  }

  // Layer 3: Provider + 名称推断
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()

  if (provider === 'firstParty' || provider === 'foundry') {
    return !canonical.includes('claude-3-')
  }

  return canonical.includes('sonnet-4') || canonical.includes('opus-4')
}
```

### DeepSeek 模型检测流程

```
输入: model = 'deepseek/deepseek-chat'

Layer 1: get3PModelCapabilityOverride()
├── Provider = openai
├── 没有配置环境变量 → return undefined

Layer 2: resolveAntModel()
├── DeepSeek 不是 Anthropic 内置模型 → 跳过

Layer 3: Provider + 名称推断
├── provider = 'openai'
├── 检查 'sonnet-4'/'opus-4' → false

结果: false (默认不支持 thinking)
```

---

## 7. 完整流程：DeepSeek 模型调用示例

```
用户: "What is 123 * 456?"

1. Claude Code 前端
   ├─ 创建 QueryLoop
   ├─ 构建 System Prompt
   └─ 检查模型能力

2. API 调用
   ├─ Provider: 'openai'
   ├─ OpenAI SDK 调用
   │   client.chat.completions.create({
   │     model: 'qwen/qwen2.5-coder-32b-instruct',
   │     thinking: { type: 'adaptive' }
   │   })
   └─ DeepSeek API: 不识别 thinking 参数 → 忽略

3. 模型响应
   └─ delta.content = "56088"
   └─ 无 reasoning_content

4. 处理响应
   └─ 无 thinking 内容显示

结果: 用户直接看到回答
```

---

## 8. 总结

### Claude Code 调用第三方模型的关键

1. **调用工具**：使用 **OpenAI SDK**
2. **检测 Provider**：`getAPIProvider()` 返回 `'openai'`
3. **调用链**：queryModelOpenAI() → 格式转换 → SDK 调用 → 响应适配
4. **Thinking 处理**：
   - 原生支持：`reasoning_content` + Stream 适配器
   - 非支持：Prompt 引导 + 正则解析

### 核心理解

- **OpenAI SDK 是通用接口**，可连接任何兼容的 LLM 提供商
- **Stream 适配器统一响应格式**，让上层代码无需关心底层模型差异
- **模型能力检测是声明性的**，实际支持取决于模型本身

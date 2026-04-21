# 函数调用 (Tool Calling) 机制详解

## 1. 核心概念

大模型的函数调用本质是一个**文本交互协议**，不是 API 级别的固定格式。

### 三种主流实现方式

| 方式 | 厂商 | 示例 |
|------|------|------|
| **Native Function Calling** | OpenAI, Anthropic | API 直接支持 tool 参数 |
| **XML/JSON 标记** | 开源模型 | 在 response 中输出 XML |
| **自然语言描述** | 所有模型 | 纯文本 prompt 引导 |

---

## 2. OpenAI/Anthropic 官方格式

### 工具定义 (传递给模型)

```typescript
// OpenAI 格式
{
  type: "function",
  function: {
    name: "calculate",
    description: "计算数学表达式",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "表达式如 2+2*3" }
      },
      required: ["expression"]
    }
  }
}

// Anthropic 格式
{
  name: "calculate",
  description: "计算数学表达式", 
  input_schema: {
    type: "object",
    properties: {
      expression: { type: "string", description: "表达式" }
    },
    required: ["expression"]
  }
}
```

### 模型返回调用

```json
// OpenAI
{
  tool_calls: [{
    id: "call_123",
    type: "function",
    function: { name: "calculate", arguments: "{\"expression\":\"2+2\"}" }
  }]
}

// Anthropic
{
  content: [{
    type: "tool_use",
    id: "toolu_123",
    name: "calculate",
    input: { expression: "2+2" }
  }]
}
```

---

## 3. Claude Code 的做法

### 3.1 工具定义 → System Prompt

Claude Code **不依赖官方 function calling API**，而是用自然语言把工具描述写入 system prompt：

```typescript
function getToolsSection(tools: Tool[]) {
  return tools.map(tool => 
    `## ${tool.name}: ${tool.description}
Parameters:
${JSON.stringify(tool.inputSchema, null, 2)}`
  ).join('\n\n')
}
```

生成的 system prompt 片段：

```
## calculate: 计算数学表达式
Parameters:
{
  "type": "object",
  "properties": {
    "expression": { "type": "string", "description": "表达式如 2+2*3" }
  },
  "required": ["expression"]
}
```

### 3.2 Tool 执行流程

```
1. 构建 system prompt (包含工具定义)
2. 发送给模型
3. 模型返回文本 (可能包含 tool call XML)
4. 解析 XML: <tool name="xxx"><param name="key">value</param></tool>
5. 执行工具函数
6. 把结果作为 user message 加入对话
7. 继续循环
```

### 3.3 buildTool 工厂

```typescript
export function buildTool<D>(def: D) {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    execute: def.execute,
  }
}
```

---

## 4. 为什么 Claude Code 不用官方 API？

### 优点
1. **兼容所有模型** - 不管是 OpenAI 还是开源模型
2. **更可控** - 可以自定义输出格式
3. **调试简单** - 纯文本可见

### 缺点
1. **依赖 prompt 质量** - 模型可能不按格式输出
2. **解析脆弱** - 需要正则提取

---

## 5. 我们当前的实现

### System Prompt 构建

```typescript
const SYSTEM_PROMPT = `You have access to tools.

Available tools:
- calculate: Evaluate math expressions

When you need to use a tool, respond with:
<tool_call>
<tool name="tool_name">
<param name="key">value</param>
</tool>
</tool_call>`
```

### 工具定义 (Zod)

```typescript
const tools = [{
  name: 'calculate',
  description: 'Evaluate math expressions',
  inputSchema: z.object({
    expression: z.string()
  }),
  execute: async ({ expression }) => String(eval(expression))
}]
```

### 调用结果处理

```typescript
// 从模型输出中提取 tool call
const toolMatches = content.matchAll(/<tool name="(\w+)">([\s\S]*?)<\/tool>/g)

// 执行工具
const result = await tool.execute(input)

// 把结果加入对话
messages.push({ role: 'user', content: `<tool_result>${result}</tool_result>` })
```

---

## 6. 总结

| 层面 | Claude Code | 官方 API |
|------|-------------|-----------|
| 工具格式 | JSON Schema | JSON Schema |
| 调用触发 | XML 标记文本 | API 字段 |
| 结果处理 | 文本拼接 | API 返回结构 |
| 适用模型 | 任何文本模型 | 支持的专有模型 |

核心理解：**function calling 本质是让模型输出特定格式的文本，我们解析后执行。**

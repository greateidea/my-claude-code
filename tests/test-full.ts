import { z } from 'zod'
import { DeepSeekClient } from '../src/services/api/deepseek.js'
import { createQueryLoop, buildSystemPrompt, type Tool } from '../src/services/queryLoop.js'

const tools: Tool[] = [
  {
    name: 'calculate',
    description: 'Evaluate math expression',
    inputSchema: { expression: z.string() },
    execute: async ({ expression }: any) => {
      console.log('[EXECUTE calculate] expression:', expression)
      try {
        const result = Function(`"use strict"; return (${expression})`)()
        return String(result)
      } catch (e: any) { return `Error: ${e.message}` }
    },
  },
]

const BASE_PROMPT = `You are a helpful AI assistant. You have a "calculate" tool for math.

STRICT Rules:
1. You MUST use <thinking> tags for ALL reasoning
2. You MUST call calculate tool for math problems
3. Never calculate in your head

Use this format ALWAYS:

First, your thinking:
<thinking>
Step 1: ...
Step 2: ...
</thinking>

Then, call the tool:
<tool_call>
<tool name="calculate">
<param name="expression">...</param>
</tool_call>

Finally, give the answer.`

async function test() {
  console.log('=== Test: Thinking + Tool Call ===\n')
  
  const apiKey = process.env.NVIDIA_API_KEY!
  const client = new DeepSeekClient({ apiKey })

  const queryLoop = createQueryLoop({
    client,
    tools,
    systemPrompt: buildSystemPrompt(tools, BASE_PROMPT),
    maxTurns: 3,
    initialMessages: [{ role: 'user', content: '1+2*3等于多少？思考并用工具计算' }],
  })

  console.log('User: 1+2*3等于多少？思考并用工具计算\n')

  let stepCount = 0
  let hasThinking = false
  let hasToolCall = false
  let toolResult = ''
  
  for await (const step of queryLoop) {
    stepCount++
    console.log(`\n--- Step ${stepCount}: ${step.type} ---`)
    
    if (step.type === 'thinking') {
      console.log('💭 Thinking:', step.content?.slice(0, 200))
      hasThinking = !!step.content
    } else if (step.type === 'message') {
      console.log('📝 Message:', step.content?.slice(0, 200))
    } else if (step.type === 'tool') {
      console.log('🔧 Tool call:', step.toolUse)
      console.log('📋 Tool result:', step.toolResult)
      hasToolCall = !!step.toolUse
      toolResult = step.toolResult || ''
    } else if (step.type === 'error') {
      console.log('❌ Error:', step.content)
    }
  }

  console.log('\n=== Results ===')
  console.log('Has thinking:', hasThinking ? '✅' : '❌')
  console.log('Has tool call:', hasToolCall ? '✅' : '❌')
  console.log('Tool result:', toolResult)
}

test().catch(e => console.error('Fatal:', e.message))
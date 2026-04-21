import { DeepSeekClient } from './src/services/api/deepseek.js'
import { createQueryLoop, type Tool, findToolCalls } from './src/services/queryLoop.js'
import { z } from 'zod'

const tools: Tool[] = [
  {
    name: 'calculate',
    description: 'Evaluate math expressions',
    inputSchema: { expression: z.string() },
    execute: async ({ expression }: any) => {
      try {
        const result = Function(`"use strict"; return (${expression})`)()
        return String(result)
      } catch (e: any) { return `Error: ${e.message}` }
    },
  },
]

// 更强的 prompt
const SYSTEM_PROMPT = `You are a helpful AI assistant. You have a "calculate" tool for math.

Rules:
- ALWAYS use calculate tool for ANY math problem
- NEVER calculate in your head - always use the tool
- When you need to calculate, respond ONLY with the tool call, nothing else

Tool call format:
<tool_call>
<tool name="calculate">
<param name="expression">3+3</param>
</tool_call>`

async function test() {
  const client = new DeepSeekClient({ apiKey: process.env.NVIDIA_API_KEY! })
  
  console.log('=== Test: 3+1+5-2 ===\n')
  
  const loop = createQueryLoop({
    client,
    tools,
    systemPrompt: SYSTEM_PROMPT,
    maxTurns: 3,
    initialMessages: [{ role: 'user', content: '3+1+5-2等于多少？' }],
  })

  for await (const step of loop) {
    console.log('Step:', step.type)
    if (step.type === 'message') {
      console.log('  content:', step.content?.slice(0, 200))
    } else if (step.type === 'tool') {
      console.log('  tool:', step.toolUse)
      console.log('  result:', step.toolResult)
    }
  }
  
  console.log('\n=== Done ===')
}

test().catch(console.error)
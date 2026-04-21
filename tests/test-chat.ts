import { z } from 'zod'
import { DeepSeekClient } from './src/services/api/deepseek.js'
import { createQueryLoop, type Tool } from './src/services/queryLoop.js'

const tools: Tool[] = [
  {
    name: 'echo',
    description: 'Echo back text',
    inputSchema: { text: z.string() },
    execute: async ({ text }: any) => `Echo: ${text}`,
  },
  {
    name: 'calculate',
    description: 'Evaluate math',
    inputSchema: { expression: z.string() },
    execute: async ({ expression }: any) => {
      try {
        const result = Function(`"use strict"; return (${expression})`)()
        return String(result)
      } catch (e: any) { return `Error: ${e.message}` }
    },
  },
]

const SYSTEM_PROMPT = `You are a helpful assistant with access to tools.

Available tools:
${tools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

When you need to use a tool, respond with EXACTLY this XML format:
<tool_call>
<tool name="${tools.map(t => t.name).join('|')}">
<param name="param_key">value</param>
</tool_call>`

async function test() {
  console.log('=== Test Full QueryLoop ===\n')
  const client = new DeepSeekClient({ apiKey: process.env.NVIDIA_API_KEY! })
  
  const queryLoop = createQueryLoop({
    client,
    tools,
    systemPrompt: SYSTEM_PROMPT,
    maxTurns: 5,
    initialMessages: [{ role: 'user', content: 'Calculate 2+2*3' }],
  })

  console.log('User: Calculate 2+2*3\n')
  
  for await (const step of queryLoop) {
    if (step.type === 'message') {
      console.log('AI:', step.content)
    } else if (step.type === 'tool') {
      console.log('Tool:', step.toolUse?.name, step.toolUse?.input)
      console.log('Result:', step.toolResult)
    }
  }
  
  console.log('\nDone!')
}

test().catch(e => console.error('Error:', e.message))
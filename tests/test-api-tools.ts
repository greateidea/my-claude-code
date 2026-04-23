import { z } from 'zod'
import { DeepSeekClient } from '../src/services/api/deepseek.js'
import { createQueryLoop, buildSystemPrompt, type Tool } from '../src/services/queryLoop.js'

// Convert Zod tool to OpenAI format
function toolToOpenAI(tool: Tool): any {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: tool.inputSchema,
        required: Object.keys(tool.inputSchema),
      },
    },
  }
}

const tools: Tool[] = [
  {
    name: 'calculate',
    description: 'Evaluate math expression',
    inputSchema: { expression: z.string() },
    execute: async ({ expression }: any) => {
      console.log('[EXECUTE calculate]', expression)
      try {
        const result = Function(`"use strict"; return (${expression})`)()
        return String(result)
      } catch (e: any) { return `Error: ${e.message}` }
    },
  },
]

const BASE_PROMPT = `You are a helpful AI assistant. Use the calculate tool when needed.`

async function test() {
  console.log('=== Test: Official API Tool Calling ===\n')
  
  const apiKey = process.env.NVIDIA_API_KEY!
  const client = new DeepSeekClient({ apiKey })

  // Convert tools to OpenAI format
  const openaiTools = tools.map(toolToOpenAI)

  const queryLoop = createQueryLoop({
    client,
    tools,
    systemPrompt: BASE_PROMPT,
    maxTurns: 3,
    initialMessages: [{ role: 'user', content: '1+2*3等于多少？' }],
    openaiTools,  // Pass official API tools
  })

  console.log('User: 1+2*3等于多少？\n')

  let stepCount = 0
  for await (const step of queryLoop) {
    stepCount++
    console.log(`--- Step ${step.type} ---`)
    
    if (step.type === 'message') {
      console.log('Message:', step.content?.slice(0, 100))
    } else if (step.type === 'tool') {
      console.log('Tool:', step.toolUse)
      console.log('Result:', step.toolResult)
    }
  }
}

test().catch(e => console.error('Error:', e.message))
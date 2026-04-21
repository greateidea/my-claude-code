import { z } from 'zod'
import { DeepSeekClient } from './src/services/api/deepseek.js'
import { createQueryLoop, buildSystemPrompt, type Tool } from './src/services/queryLoop.js'

const tools: Tool[] = [
  {
    name: 'calculate',
    description: 'Evaluate math expression',
    inputSchema: { expression: z.string() },
    execute: async ({ expression }: any) => {
      try {
        const result = Function(`"use strict"; return (${expression})`)()
        return String(result)
      } catch (e: any) { return `Error: ${e.message}` }
    },
  },
]

const BASE_PROMPT = `You are a helpful assistant with access to tools.`

async function test() {
  console.log('=== Test Thinking Extraction ===\n')
  const client = new DeepSeekClient({ apiKey: process.env.NVIDIA_API_KEY! })

  const queryLoop = createQueryLoop({
    client,
    tools,
    systemPrompt: buildSystemPrompt(tools, BASE_PROMPT),
    maxTurns: 3,
    initialMessages: [{ role: 'user', content: 'What is 123 * 456? Think about it first in <thinking> tags.' }],
  })

  console.log('User: What is 123 * 456? Think about it first in <thinking> tags.\n')

  for await (const step of queryLoop) {
    if (step.type === 'thinking') {
      console.log('💭 Thinking:', step.content)
    } else if (step.type === 'message') {
      console.log('📝 Message:', step.content)
    } else if (step.type === 'tool') {
      console.log('🔧 Tool:', step.toolUse?.name, step.toolUse?.input)
      console.log('📋 Result:', step.toolResult)
    }
  }

  console.log('\n=== Done! ===')
}

test().catch(e => console.error('Error:', e.message))
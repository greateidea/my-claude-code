import { z } from 'zod'
import { DeepSeekClient } from '../src/services/api/deepseek.js'
import { createQueryLoop, buildSystemPrompt, type Tool } from '../src/services/queryLoop.js'

const tools: Tool[] = [
  {
    name: 'calculate',
    description: 'Evaluate math expression',
    inputSchema: { expression: z.string() },
    execute: async ({ expression }: any) => {
      console.log('[Tool] calculate called with:', expression)
      try {
        const result = Function(`"use strict"; return (${expression})`)()
        return String(result)
      } catch (e: any) { return `Error: ${e.message}` }
    },
  },
]

const BASE_PROMPT = `You are a helpful assistant with access to tools.`

async function test() {
  console.log('=== Test: API Call Debug ===\n')
  
  const apiKey = process.env.NVIDIA_API_KEY
  console.log('API Key exists:', !!apiKey)
  console.log('API Key prefix:', apiKey?.slice(0, 10))
  
  const client = new DeepSeekClient({ apiKey: apiKey! })
  console.log('Client created')

  // Test direct API call first
  console.log('\n--- Direct API call test ---')
  const messages = [{ role: 'user', content: 'hi' }]
  try {
    console.log('Sending to API...')
    const response = await client.chat({ messages, maxTokens: 50 })
    console.log('Response received!')
    console.log('Content:', response.message.content?.slice(0, 200))
  } catch (e: any) {
    console.log('API Error:', e.message)
  }

  console.log('\n=== QueryLoop test ===')
  const queryLoop = createQueryLoop({
    client,
    tools,
    systemPrompt: buildSystemPrompt(tools, BASE_PROMPT),
    maxTurns: 2,
    initialMessages: [{ role: 'user', content: '2+2' }],
  })

  let stepCount = 0
  for await (const step of queryLoop) {
    stepCount++
    console.log(`Step ${stepCount}:`, step.type)
    if (step.type === 'thinking') {
      console.log('💭 Thinking:', step.content?.slice(0, 100))
    } else if (step.type === 'message') {
      console.log('📝 Message:', step.content?.slice(0, 100))
    } else if (step.type === 'tool') {
      console.log('🔧 Tool:', step.toolUse)
      console.log('📋 Result:', step.toolResult)
    } else if (step.type === 'error') {
      console.log('❌ Error:', step.content)
    }
  }

  console.log('\n=== Done! Steps:', stepCount, '===')
}

test().catch(e => console.error('Fatal Error:', e.message))
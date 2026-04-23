import { z } from 'zod'
import { DeepSeekClient } from '../src/services/api/deepseek.js'
import { createQueryLoop, buildSystemPrompt, type Tool } from '../src/services/queryLoop.js'

const tools: Tool[] = [
  {
    name: 'calculate',
    description: 'Evaluate math expression',
    inputSchema: { expression: z.string() },
    execute: async ({ expression }: any) => String(expression),
  },
]

const BASE_PROMPT = `You are a helpful assistant. Use <thinking> tags for reasoning.`

async function test() {
  console.log('=== Test: Simple API Call ===')
  
  const apiKey = process.env.NVIDIA_API_KEY!
  console.log('API Key:', apiKey.slice(0, 8) + '...')
  
  const client = new DeepSeekClient({ apiKey })
  console.log('Client created')

  // Simple test with timeout
  console.log('\n--- Testing with 10s timeout ---')
  
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    console.log('⏱️ Timeout!')
    controller.abort()
  }, 10000)

  try {
    const response = await client.chat({ 
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 20 
    })
    clearTimeout(timeout)
    console.log('✅ Response:', response.message.content)
  } catch (e: any) {
    clearTimeout(timeout)
    console.log('❌ Error:', e.message)
  }
}

test().catch(e => console.error('Fatal:', e.message))
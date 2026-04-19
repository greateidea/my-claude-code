#!/usr/bin/env bun

import { DeepSeekClient } from '../src/services/api/deepseek.js'

async function testAPI() {
  const apiKey = process.env.DEEPSEEK_API_KEY
  
  if (!apiKey) {
    console.error('Error: DEEPSEEK_API_KEY not set')
    console.log('\nSet your API key:')
    console.log('  export DEEPSEEK_API_KEY="your-key-here"')
    process.exit(1)
  }

  const client = new DeepSeekClient({ apiKey })
  
  console.log('Testing DeepSeek API...')
  
  try {
    const response = await client.chat({
      messages: [
        { role: 'user', content: 'Say "Hello, world!" in exactly 3 words.' }
      ],
      model: 'deepseek-chat',
      maxTokens: 50,
    })

    console.log('\nResponse:')
    console.log(response.message.content)
    
    if (response.usage) {
      console.log('\nUsage:')
      console.log(`  Prompt: ${response.usage.promptTokens}`)
      console.log(`  Completion: ${response.usage.completionTokens}`)
      console.log(`  Total: ${response.usage.totalTokens}`)
    }
    
    console.log('\n✅ API working!')
  } catch (error: any) {
    console.error('\n❌ Error:', error.message)
    process.exit(1)
  }
}

testAPI()
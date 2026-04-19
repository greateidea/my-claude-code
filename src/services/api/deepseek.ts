import { default as OpenAI } from 'openai'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface ChatOptions {
  messages: ChatMessage[]
  model?: string
  temperature?: number
  maxTokens?: number
}

export interface ChatResponse {
  message: ChatMessage
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

const DEFAULT_MODEL = 'minimaxai/minimax-m2.7'

export class DeepSeekClient {
  private client: OpenAI

  constructor(options: { apiKey: string; baseURL?: string }) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL || 'https://integrate.api.nvidia.com/v1',
    })
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const response = await this.client.chat.completions.create({
      model: options.model || DEFAULT_MODEL,
      messages: options.messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
    })

    const choice = response.choices[0]
    
    return {
      message: {
        role: 'assistant',
        content: choice.message.content || '',
      },
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    }
  }

  static fromEnv(): DeepSeekClient | null {
    const apiKey = process.env.DEEPSEEK_API_KEY || process.env.NVIDIA_API_KEY
    if (!apiKey) {
      return null
    }
    return new DeepSeekClient({ apiKey })
  }
}
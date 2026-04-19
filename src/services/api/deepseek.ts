import { default as OpenAI } from 'openai'
import type { Message } from '../../state/AppStateStore'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface ChatOptions {
  messages: ChatMessage[]
  model?: string
  temperature?: number
  maxTokens?: number
  stream?: boolean
  onChunk?: (content: string, reasoning?: string) => void
}

export interface ChatResponse {
  message: ChatMessage
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

const DEFAULT_MODEL = 'qwen/qwen2.5-coder-32b-instruct'
const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1'

export interface StreamOptions {
  onChunk?: (content: string, reasoning?: string) => void
}

export class DeepSeekClient {
  private client: OpenAI
  public currentMessagesRef: { current: Message[] | null }

  constructor(options: { apiKey: string; baseURL?: string }) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL || DEFAULT_BASE_URL,
    })
    this.currentMessagesRef = { current: null }
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    if (options.stream && options.onChunk) {
      return this.streamChat(options)
    }

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

  private async streamChat(options: ChatOptions): Promise<ChatResponse> {
    const fullContent: string[] = []
    const fullReasoning: string[] = []

    const response = await this.client.chat.completions.create({
      model: options.model || DEFAULT_MODEL,
      messages: options.messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    })

    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta as any
      const content = delta?.content || ''
      const reasoning = delta?.reasoning_content || ''
      
      if (content) fullContent.push(content)
      if (reasoning) fullReasoning.push(reasoning)
      
      if (content || reasoning) {
        options.onChunk?.(content, reasoning)
      }
    }

    return {
      message: {
        role: 'assistant',
        content: fullContent.join(''),
      },
      usage: undefined,
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
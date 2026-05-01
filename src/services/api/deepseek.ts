import { default as OpenAI } from 'openai'
import type { Message } from '../../state/AppStateStore'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export interface ChatOptions {
  messages: ChatMessage[]
  model?: string
  temperature?: number
  maxTokens?: number
  stream?: boolean
  onChunk?: (content: string, reasoning?: string) => void
  tools?: OpenAI.ChatCompletionTool[]
}

export interface ChatResponse {
  message: ChatMessage
  reasoning?: string
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

const DEFAULT_MODEL = 'qwen/qwen3-next-80b-a3b-thinking'
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
      maxRetries: 1,
      timeout: 30000, // 30 second timeout
    })
    this.currentMessagesRef = { current: null }
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    if (options.stream && options.onChunk) {
      return this.streamChat(options)
    }

    const response = await this.client.chat.completions.create({
      model: options.model || DEFAULT_MODEL,
      messages: options.messages as any,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      ...(options.tools && { tools: options.tools }),
    })

    const choice = response.choices[0]
    const rawToolCalls = choice.message.tool_calls as any[] || []
    const reasoning = (choice.message as any)?.reasoning_content || undefined

    return {
      message: {
        role: 'assistant',
        content: choice.message.content || '',
      },
      reasoning,
      toolCalls: rawToolCalls.map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || '',
      })),
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
    const toolCallsByIndex = new Map<number, { id: string; name: string; arguments: string }>()
    let streamUsage: ChatResponse['usage']

    const response = await this.client.chat.completions.create({
      model: options.model || DEFAULT_MODEL,
      messages: options.messages as any,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...(options.tools && { tools: options.tools }),
    })

    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta as any
      const content = delta?.content || ''
      const reasoning = delta?.reasoning_content || ''

      // Accumulate tool_calls from streaming deltas (incremental by index)
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index as number
          const existing = toolCallsByIndex.get(idx) || { id: '', name: '', arguments: '' }
          if (tc.id) existing.id = tc.id
          if (tc.function?.name) existing.name += tc.function.name
          if (tc.function?.arguments) existing.arguments += tc.function.arguments
          toolCallsByIndex.set(idx, existing)
        }
      }

      // Capture usage from final chunk (stream_options include_usage)
      if (chunk.usage) {
        streamUsage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        }
      }

      if (content) fullContent.push(content)
      if (reasoning) fullReasoning.push(reasoning)

      if (content || reasoning) {
        options.onChunk?.(content, reasoning)
      }
    }

    // Convert accumulated tool_calls to response format
    const toolCalls = Array.from(toolCallsByIndex.values()).map(tc => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    }))

    return {
      message: {
        role: 'assistant',
        content: fullContent.join(''),
      },
      reasoning: fullReasoning.length > 0 ? fullReasoning.join('') : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: streamUsage,
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
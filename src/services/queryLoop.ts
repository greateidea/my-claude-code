import { z } from 'zod'
import { DeepSeekClient, type ChatMessage } from './api/deepseek'

export interface Tool {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  execute: (input: any) => Promise<string>
}

type ZodRawShape = Parameters<typeof z.object>[0]

export interface QueryLoopConfig {
  client: DeepSeekClient
  tools?: Tool[]
  maxTurns?: number
  systemPrompt?: string
  initialMessages?: ChatMessage[]
  onMessage?: (content: string, isToolResult?: boolean) => void
}

export interface QueryResult {
  reason: 'completed' | 'max_turns' | 'error'
  turnCount: number
  error?: string
}

export interface QueryStep {
  type: 'message' | 'tool' | 'error' | 'thinking'
  content?: string
  toolUse?: { name: string; input: Record<string, string> }
  toolResult?: string
}

export function findToolCalls(content: string): { name: string; input: Record<string, string> }[] {
  const results: { name: string; input: Record<string, string> }[] = []
  const toolRegex = /<tool name="(\w+)">([\s\S]*?)<\/tool>/g
  let match
  while ((match = toolRegex.exec(content)) !== null) {
    const name = match[1]
    const body = match[2]
    const input: Record<string, string> = {}
    const paramRegex = /<param name="([^"]+)">([^<]+)<\/param>/g
    let paramMatch
    while ((paramMatch = paramRegex.exec(body)) !== null) {
      input[paramMatch[1]] = paramMatch[2]
    }
    results.push({ name, input })
  }
  return results
}

function createToolExecutor(tools: Tool[]) {
  const toolMap = new Map(tools.map(t => [t.name, t.execute]))
  return {
    execute(name: string, input: Record<string, any>): Promise<string> {
      const fn = toolMap.get(name)
      if (!fn) return Promise.resolve(`Tool "${name}" not found`)
      return fn(input).catch((e: Error) => `Error: ${e.message}`)
    },
  }
}

const THINKING_REGEX = /<thinking>([\s\S]*?)<\/thinking>/gi

export function extractThinkingContent(content: string): string | null {
  const match = THINKING_REGEX.exec(content)
  if (match) {
    return match[1]?.trim() ?? null
  }
  return null
}

export function stripThinkingContent(content: string): string {
  return content.replace(THINKING_REGEX, '').trim()
}

export function buildSystemPrompt(tools: Tool[], basePrompt: string): string {
  const thinkingInstruction = `
IMPORTANT: When you need to think through a problem before answering, wrap your reasoning in <thinking> tags:

<thinking>
Your step-by-step reasoning goes here...
</thinking>

Then provide your final answer. The thinking will be displayed to help the user understand your process.

`

  const toolList = tools.map(t => {
    const params = t.inputSchema
    const paramsStr = Object.entries(params)
      .map(([key, schema]) => {
        const s = schema as any
        return `- ${key}: ${s.description || key}`
      })
      .join('\n')
    return `name:${t.name}\ndescription:${t.description}\nParameters:\n${paramsStr}`
  }).join('\n\n')
  
  return `${basePrompt}${thinkingInstruction}\n\nTools:\n${toolList}`
}

export async function* createQueryLoop(config: QueryLoopConfig): AsyncGenerator<QueryStep, QueryResult, unknown> {
  const toolExecutor = createToolExecutor(config.tools ?? [])
  const messages: ChatMessage[] = []
  
  if (config.systemPrompt) {
    messages.push({ role: 'system', content: config.systemPrompt })
  }
  
  if (config.initialMessages) {
    messages.push(...config.initialMessages)
  }

  let turnCount = 0
  const maxTurns = config.maxTurns ?? 10

  while (turnCount < maxTurns) {
    turnCount++

    try {
      const response = await config.client.chat({ messages, maxTokens: 1500 })
      
      const rawContent = response.message.content ?? ''

      const thinking = extractThinkingContent(rawContent)
      if (thinking) {
        yield { type: 'thinking', content: thinking }
        config.onMessage?.(`[thinking] ${thinking}`, false)
      }

      const content = stripThinkingContent(rawContent)
      config.onMessage?.(content, false)
      yield { type: 'message', content }

      if (content) {
        messages.push({ role: 'assistant', content })
      } else if (thinking) {
        // If there's only thinking and no actual content, still store it
        messages.push({ role: 'assistant', content: rawContent })
      }

      const toolCalls = findToolCalls(content)
      
      if (toolCalls.length === 0) {
        return { reason: 'completed', turnCount }
      }

      for (const tc of toolCalls) {
        const result = await toolExecutor.execute(tc.name, tc.input)
        
        yield { type: 'tool', toolUse: tc, toolResult: result }
        
        const toolResultContent = `<tool_result>\n${result}\n</tool_result>`
        config.onMessage?.(toolResultContent, true)
        messages.push({ role: 'user', content: toolResultContent })
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      yield { type: 'error', content: errMsg }
      return { reason: 'error', turnCount, error: errMsg }
    }
  }

  return { reason: 'max_turns', turnCount }
}
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
  openaiTools?: any[]  // Official API tool format
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
  
  // 两种格式都支持:
  // 1. <tool name="calculate"><param name="expression">1+2</param></tool>
  // 2. <tool_call>calculate{"expression":"1+2"}</tool_call>
  
  // 格式 1
  const toolRegex1 = /<tool name="(\w+)">([\s\S]*?)<\/tool>/g
  let match
  while ((match = toolRegex1.exec(content)) !== null) {
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
  
  // 格式 2: <tool_call>toolName{...}</tool_call> 或 <tool_call>\ntoolName\n{...}\n</tool_call>
  const toolRegex2 = /<tool_call>\s*(\w+)\s*\{([^}]+)\}\s*<\/tool_call>/g
  while ((match = toolRegex2.exec(content)) !== null) {
    const name = match[1]
    const jsonStr = '{' + match[2] + '}'
    try {
      const input = JSON.parse(jsonStr)
      results.push({ name, input })
    } catch {
      // skip invalid JSON
    }
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
      const chatOptions: any = { messages, maxTokens: 1500 }
      if (config.openaiTools) {
        chatOptions.tools = config.openaiTools
        chatOptions.system = config.systemPrompt
      } else if (config.tools) {
        chatOptions.system = config.systemPrompt || messages[0]?.content
      }
      
      const response = await config.client.chat(chatOptions)
      
      // 检查官方 API 返回的 tool_calls
      const apiToolCalls = response.toolCalls || []
      
      // 如果有官方 API tool_calls，直接执行
      for (const tc of apiToolCalls) {
        try {
          const args = JSON.parse(tc.arguments)
          const result = await toolExecutor.execute(tc.name, args)
          yield { type: 'tool', toolUse: { name: tc.name, input: args }, toolResult: result }
          messages.push({ 
            role: 'user', 
            content: JSON.stringify({ name: tc.name, result }) 
          })
        } catch (e: any) {
          yield { type: 'error', content: `Tool error: ${e.message}` }
        }
      }
      
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
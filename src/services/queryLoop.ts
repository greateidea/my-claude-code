import { z } from 'zod'
import { DeepSeekClient, type ChatMessage } from './api/deepseek'
import { partitionToolCalls, hasToolCalls } from './toolOrchestration'

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
  
  // 只解析 prompt 格式（当没有 openaiTools 时使用）
  // 如果有 openaiTools，应该使用 API 返回的 toolCalls，不是这个
  
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
  
  const toolRegex2 = /<tool_call>\s*(\w+)\s*\{([^}]+)\}\s*<\/tool_call>/g
  while ((match = toolRegex2.exec(content)) !== null) {
    const name = match[1]
    const jsonStr = '{' + match[2] + '}'
    try {
      const input = JSON.parse(jsonStr)
      results.push({ name, input })
    } catch {}
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
      const apiToolCalls: { name: string; input: Record<string, any> }[] = (response.toolCalls || []).map((tc: any) => ({
        name: tc.name,
        input: JSON.parse(tc.arguments),
      }))
      
      // 只有在没有 openaiTools 时才解析 prompt 格式的工具调用
      const rawContent = response.message.content ?? ''
      const promptToolCalls = !config.openaiTools ? findToolCalls(rawContent) : []

      // 合并所有工具调用，统一通过 partitionToolCalls 决策
      const allToolCalls = [...apiToolCalls, ...promptToolCalls].map((tc, i) => ({
        id: `call_${turnCount}_${i}`,
        name: tc.name,
        input: tc.input,
      }))

      if (allToolCalls.length === 0) {
        const thinking = extractThinkingContent(rawContent)
        if (thinking) {
          yield { type: 'thinking', content: thinking }
          config.onMessage?.(`[thinking] ${thinking}`, false)
        }
        const content = stripThinkingContent(rawContent)
        config.onMessage?.(content, false)
        yield { type: 'message', content }
        if (content) messages.push({ role: 'assistant', content })
        else if (thinking) messages.push({ role: 'assistant', content: rawContent })
        return { reason: 'completed', turnCount }
      }

      // 先输出消息内容（包含 thinking）
      const thinking = extractThinkingContent(rawContent)
      if (thinking) {
        yield { type: 'thinking', content: thinking }
        config.onMessage?.(`[thinking] ${thinking}`, false)
      }
      const content = stripThinkingContent(rawContent)
      config.onMessage?.(content, false)
      yield { type: 'message', content }
      if (content) messages.push({ role: 'assistant', content })
      else if (thinking) messages.push({ role: 'assistant', content: rawContent })

      // 使用 partitionToolCalls 统一决策并行/串行
      const batches = partitionToolCalls(allToolCalls)
      
      for (const batch of batches) {
        if (batch.isConcurrencySafe && batch.calls.length > 1) {
          // 并行执行
          const results = await Promise.all(
            batch.calls.map(tc => toolExecutor.execute(tc.name, tc.input))
          )
          for (let i = 0; i < batch.calls.length; i++) {
            const tc = batch.calls[i]
            const result = results[i]
            yield { type: 'tool', toolUse: { name: tc.name, input: tc.input }, toolResult: result }
            const toolResultContent = `<tool_result>\n${result}\n</tool_result>`
            config.onMessage?.(toolResultContent, true)
            messages.push({ role: 'user', content: toolResultContent })
          }
        } else {
          // 串行执行
          for (const tc of batch.calls) {
            const result = await toolExecutor.execute(tc.name, tc.input)
            yield { type: 'tool', toolUse: { name: tc.name, input: tc.input }, toolResult: result }
            const toolResultContent = `<tool_result>\n${result}\n</tool_result>`
            config.onMessage?.(toolResultContent, true)
            messages.push({ role: 'user', content: toolResultContent })
          }
        }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      yield { type: 'error', content: errMsg }
      return { reason: 'error', turnCount, error: errMsg }
    }
  }

  return { reason: 'max_turns', turnCount }
}
import { z } from 'zod'
import { DeepSeekClient, type ChatMessage } from './api/deepseek'
import { runToolCalls, type ToolCall, partitionToolCalls } from './toolOrchestration'
import { permissionManager, type PermissionRequest, type PermissionResponse } from './permissions'
import { type ThinkingConfig, DEFAULT_THINKING_CONFIG } from '../types/thinking'

export interface Tool {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  execute: (input: any) => Promise<string>
}

export interface QueryLoopConfig {
  client: DeepSeekClient
  tools?: Tool[]
  maxTurns?: number
  systemPrompt?: string
  initialMessages?: ChatMessage[]
  onMessage?: (content: string, isToolResult?: boolean) => void
  openaiTools?: any[]
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionResponse>
  cwd?: string
  thinkingConfig?: ThinkingConfig
  onThinkingChunk?: (reasoning: string) => void
}

export interface QueryResult {
  reason: 'completed' | 'max_turns' | 'error'
  turnCount: number
  error?: string
}

export interface QueryStep {
  type: 'message' | 'tool' | 'error' | 'thinking' | 'permission'
  content?: string
  toolUse?: { name: string; input: Record<string, string> }
  toolResult?: string
  permissionRequest?: PermissionRequest
  permissionResponse?: PermissionResponse
}

export function findToolCalls(content: string): { name: string; input: Record<string, string> }[] {
  const results: { name: string; input: Record<string, string> }[] = []
  
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
      return fn(input).catch((e: any) => `Error: ${e.message}`)
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
  const thinkingConfig = config.thinkingConfig ?? DEFAULT_THINKING_CONFIG
  const thinkingEnabled = thinkingConfig.type !== 'disabled'

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

      // Enable streaming when thinking is enabled for real-time reasoning_content
      if (thinkingEnabled) {
        chatOptions.stream = true
        chatOptions.onChunk = (content: string, reasoning: string) => {
          if (reasoning) config.onThinkingChunk?.(reasoning)
          if (content) config.onMessage?.(content, false)
        }
      }

      const response = await config.client.chat(chatOptions)
      
      const apiToolCalls: { name: string; input: Record<string, any>; apiId?: string }[] = (response.toolCalls || []).map((tc: any) => ({
        name: tc.name,
        input: JSON.parse(tc.arguments),
        apiId: tc.id,
      }))
      
      const rawContent = response.message.content ?? ''
      const promptToolCalls = !config.openaiTools ? findToolCalls(rawContent) : []

      const allToolCalls = [...apiToolCalls, ...promptToolCalls].map((tc, i): ToolCall => ({
        id: `call_${turnCount}_${i}`,
        name: tc.name,
        input: tc.input as any,
        apiId: (tc as any).apiId,
      }))

      if (allToolCalls.length === 0) {
        // Prefer native reasoning_content from API, fall back to XML extraction
        const thinking = response.reasoning || extractThinkingContent(rawContent)
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

      // Prefer native reasoning_content from API, fall back to XML extraction
      const thinking = response.reasoning || extractThinkingContent(rawContent)
      if (thinking) {
        yield { type: 'thinking', content: thinking }
        config.onMessage?.(`[thinking] ${thinking}`, false)
      }
      const content = stripThinkingContent(rawContent)
      config.onMessage?.(content, false)
      yield { type: 'message', content }

      // Store assistant message — WITH tool_calls for native API calls so the model
      // recognizes its own tool calls. Without this, the model sees orphaned tool results
      // and re-requests the same tool indefinitely.
      if (response.toolCalls?.length) {
        messages.push({
          role: 'assistant',
          content: content || '',
          tool_calls: response.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        })
      } else if (content) {
        messages.push({ role: 'assistant', content })
      } else if (thinking) {
        messages.push({ role: 'assistant', content: rawContent })
      }

      // 委托给 toolOrchestration 处理并行/串行执行
      const permissionHandler = config.onPermissionRequest ? {
        check: (toolName: string, toolInput: Record<string, any>, cwd: string): { decision: 'allow' | 'deny' | 'ask'; result?: string } => {
          const result = permissionManager.checkPermission(toolName, toolInput, cwd)
          if (result.decision === 'deny') {
            return { decision: 'deny', result: result.rule }
          }
          if (result.decision === 'ask') {
            return { decision: 'ask' }
          }
          return { decision: 'allow' }
        },
        request: config.onPermissionRequest,
      } : undefined

      const toolResultIter = runToolCalls(
        allToolCalls,
        toolExecutor.execute,
        permissionHandler,
        config.cwd || process.cwd()
      )

      for await (const step of toolResultIter) {
        if (step.type === 'tool') {
          // 工具开始执行，记录但不 yield 结果
          config.onMessage?.(`[tool] ${step.toolCall?.name}`, true)
        } else if (step.type === 'result') {
          yield { type: 'tool', toolUse: { name: step.toolCall!.name, input: step.toolCall!.input as any }, toolResult: step.result! }
          const apiId = step.toolCall?.apiId
          if (apiId) {
            // Native tool call — use proper tool role with tool_call_id
            messages.push({ role: 'tool', tool_call_id: apiId, content: step.result! })
          } else {
            // Text-parsed tool call — fall back to user role with XML wrapper
            const toolResultContent = `<tool_result>\n${step.result!}\n</tool_result>`
            messages.push({ role: 'user', content: toolResultContent })
          }
          config.onMessage?.(step.result!, true)
        } else if (step.type === 'error') {
          yield { type: 'error', content: step.error }
        } else if (step.type === 'permission') {
          yield { type: 'permission', permissionRequest: step.permissionRequest as any }
        } else if (step.type === 'permission_response') {
          yield { type: 'permission', permissionResponse: step.permissionResponse as any }
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
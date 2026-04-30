import { z } from 'zod'
import { DeepSeekClient, type ChatMessage } from './api/deepseek'
import { partitionToolCalls, hasToolCalls } from './toolOrchestration'
import { permissionManager, type PermissionRequest, type PermissionResponse } from './permissions'

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
  openaiTools?: any[]
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionResponse>
  cwd?: string
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
    async execute(name: string, input: Record<string, any>): Promise<string> {
      const fn = toolMap.get(name)
      if (!fn) return `Tool "${name}" not found`
      try {
        return await fn(input)
      } catch (e: any) {
        return `Error: ${e.message}`
      }
    },
  }
}

function checkAndRequestPermission(
  toolName: string,
  toolInput: Record<string, any>,
  cwd: string,
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionResponse>
): { decision: 'allow' | 'deny' | 'ask'; request?: PermissionRequest; result?: string } {
  const checkResult = permissionManager.checkPermission(toolName, toolInput, cwd)

  if (checkResult.decision === 'deny') {
    return { decision: 'deny', result: `Permission denied: ${checkResult.rule || 'by rule'}` }
  }

  if (checkResult.decision === 'ask' && onPermissionRequest) {
    const request: PermissionRequest = {
      toolName,
      toolInput,
      title: toolName,
      description: JSON.stringify(toolInput, null, 2),
    }
    return { decision: 'ask', request }
  }

  return { decision: 'allow' }
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

      // 使用 partitionToolCalls 决策并行/串行
      const batches = partitionToolCalls(allToolCalls)
      const cwd = config.cwd || process.cwd()
      
      for (const batch of batches) {
        if (batch.isConcurrencySafe && batch.calls.length > 1) {
          // 并行执行: 限制并发数为 10
          const MAX_CONCURRENCY = 10
          const pending = new Set(batch.calls.map(c => c.id))
          const running: Promise<{ id: string; name: string; input: Record<string, any>; result: string }>[] = []
          const queue = [...batch.calls]
          let queueIndex = 0

          while (pending.size > 0) {
            while (running.length < MAX_CONCURRENCY && queueIndex < queue.length) {
              const tc = queue[queueIndex++]
              const permResult = checkAndRequestPermission(tc.name, tc.input, cwd, config.onPermissionRequest)
              
              if (permResult.decision === 'deny') {
                yield { type: 'tool', toolUse: { name: tc.name, input: tc.input }, toolResult: permResult.result! }
                pending.delete(tc.id)
              } else if (permResult.decision === 'ask' && config.onPermissionRequest) {
                yield { type: 'permission', permissionRequest: permResult.request }
                const response = await config.onPermissionRequest(permResult.request!)
                yield { type: 'permission', permissionResponse: response }
                if (response.allowed) {
                  permissionManager.addSessionRule(tc.name, tc.input, true)
                  running.push((async () => ({
                    id: tc.id,
                    name: tc.name,
                    input: tc.input,
                    result: await toolExecutor.execute(tc.name, tc.input)
                  }))())
                } else {
                  yield { type: 'tool', toolUse: { name: tc.name, input: tc.input }, toolResult: 'Permission denied by user' }
                  pending.delete(tc.id)
                }
              } else {
                running.push((async () => ({
                  id: tc.id,
                  name: tc.name,
                  input: tc.input,
                  result: await toolExecutor.execute(tc.name, tc.input)
                }))())
              }
            }

            if (running.length === 0) break

            const done = await Promise.race(running)
            const idx = running.findIndex(p => Promise.resolve(p) === Promise.resolve(done))
            if (idx >= 0) running.splice(idx, 1)
            pending.delete(done.id)

            yield { type: 'tool', toolUse: { name: done.name, input: done.input }, toolResult: done.result }
          }
        } else {
          // 串行执行
          for (const tc of batch.calls) {
            const permResult = checkAndRequestPermission(tc.name, tc.input, cwd, config.onPermissionRequest)
            let result: string
            
            if (permResult.decision === 'deny') {
              result = permResult.result!
            } else if (permResult.decision === 'ask' && config.onPermissionRequest) {
              yield { type: 'permission', permissionRequest: permResult.request }
              const response = await config.onPermissionRequest(permResult.request!)
              yield { type: 'permission', permissionResponse: response }
              if (!response.allowed) {
                result = 'Permission denied by user'
              } else {
                permissionManager.addSessionRule(tc.name, tc.input, true)
                result = await toolExecutor.execute(tc.name, tc.input)
              }
            } else {
              result = await toolExecutor.execute(tc.name, tc.input)
            }
            
            yield { type: 'tool', toolUse: { name: tc.name, input: tc.input }, toolResult: result }
          }
        }
        
        // 发送工具结果到消息历史
        const toolResultContent = batch.calls
          .map(tc => `<tool_result>\n${tc.name}: done</tool_result>`)
          .join('\n')
        if (toolResultContent) {
          messages.push({ role: 'user', content: toolResultContent })
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
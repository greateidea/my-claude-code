import { z } from 'zod'
import { DeepSeekClient, type ChatMessage } from './api/deepseek'
import { runToolCalls, type ToolCall, partitionToolCalls } from './toolOrchestration'
import { permissionManager, type PermissionRequest, type PermissionResponse } from './permissions'
import { type ThinkingConfig, DEFAULT_THINKING_CONFIG } from '../types/thinking'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

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
  systemPrompt?: string | string[]
  initialMessages?: ChatMessage[]
  /** Injected as a synthetic first user message (wraps CLAUDE.md, date, etc.) */
  userContext?: string
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
  /** Native API tool_call_id — set on tool steps so the caller can persist it */
  toolCallId?: string
  /** Native tool_calls from the API response — set on message steps that precede tool calls */
  toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  /** Native reasoning_content from the API — set on message steps so it can be passed back */
  reasoningContent?: string
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

export function buildSystemPrompt(tools: Tool[], basePrompt: string, env?: { cwd?: string; platform?: string; date?: string; gitStatus?: string; memoryPrompt?: string | null }): string[] {
  // ===== Static sections — identical for all users =====
  const staticSections = [
    basePrompt,
    getThinkingSection(),
    getToolListSection(tools),
  ]

  // ===== Boundary marker =====
  // Separates static (cacheable) from dynamic (session-specific) content.
  // When we later integrate with Anthropic API, this boundary tells splitSysPromptPrefix
  // where to split for cache_control marking.
  const boundary = SYSTEM_PROMPT_DYNAMIC_BOUNDARY

  // ===== Dynamic sections — vary per session =====
  const dynamicSections: string[] = []
  const envSection = getEnvironmentSection(env)
  if (envSection) dynamicSections.push(envSection)
  // Memory system prompt (instructions + existing memories) — follows environment
  if (env?.memoryPrompt) dynamicSections.push(env.memoryPrompt)

  return [...staticSections, boundary, ...dynamicSections]
}

/** Static: thinking guidance (same for all users) */
function getThinkingSection(): string {
  return `IMPORTANT: When you need to think through a problem before answering, wrap your reasoning in <thinking> tags:

<thinking>
Your step-by-step reasoning goes here...
</thinking>

Then provide your final answer. The thinking will be displayed to help the user understand your process.`
}

/** Static: tool list (derived from tool definitions, same for all users of this build) */
function getToolListSection(tools: Tool[]): string {
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

  return `Tools:\n${toolList}`
}

/** Dynamic: environment info (varies by user/machine/session) */
function getEnvironmentSection(env?: { cwd?: string; platform?: string; date?: string; gitStatus?: string }): string | null {
  if (!env) return null
  const parts: string[] = []
  if (env.date) parts.push(`Current date: ${env.date}`)
  if (env.cwd) parts.push(`Working directory: ${env.cwd}`)
  if (env.platform) parts.push(`Platform: ${env.platform}`)
  if (env.gitStatus) parts.push(`Git status:\n${env.gitStatus}`)
  if (parts.length === 0) return null
  return '# Environment\n' + parts.join('\n')
}

const MAX_STATUS_CHARS = 2000

/**
 * Get git context for the current working directory.
 * Returns formatted git status + recent commits, or null if not a git repo.
 * Mirrors Claude Code's getGitStatus() in src/context.ts.
 */
export async function getGitContext(cwd: string): Promise<string | null> {
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd, timeout: 5000 })
  } catch {
    return null
  }

  try {
    const [branchResult, statusResult, logResult] = await Promise.allSettled([
      execFileAsync('git', ['branch', '--show-current'], { cwd, timeout: 5000 }),
      execFileAsync('git', ['status', '--short'], { cwd, timeout: 5000 }),
      execFileAsync('git', ['log', '--oneline', '-n', '5'], { cwd, timeout: 5000 }),
    ])

    const branch = branchResult.status === 'fulfilled' ? branchResult.value.stdout.trim() : 'unknown'
    const statusRaw = statusResult.status === 'fulfilled' ? statusResult.value.stdout : ''
    const log = logResult.status === 'fulfilled' ? logResult.value.stdout.trim() : ''

    const truncatedStatus = statusRaw.length > MAX_STATUS_CHARS
      ? statusRaw.substring(0, MAX_STATUS_CHARS) + '\n... (truncated, use bash to see full status)'
      : statusRaw

    return [
      `This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.`,
      `Current branch: ${branch}`,
      `Status:\n${truncatedStatus || '(clean)'}`,
      log ? `Recent commits:\n${log}` : '',
    ].filter(Boolean).join('\n\n')
  } catch {
    return null
  }
}

/** Static/dynamic boundary marker, same name as Claude Code for future compatibility */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

export async function* createQueryLoop(config: QueryLoopConfig): AsyncGenerator<QueryStep, QueryResult, unknown> {
  const toolExecutor = createToolExecutor(config.tools ?? [])
  const messages: ChatMessage[] = []

  // System prompt — join if array, keep as-is if string
  const systemPromptStr = Array.isArray(config.systemPrompt)
    ? config.systemPrompt.filter(s => s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY).join('\n\n')
    : config.systemPrompt

  if (systemPromptStr) {
    messages.push({ role: 'system', content: systemPromptStr })
  }

  // User context — injected as synthetic first user message (like Claude Code's prependUserContext)
  // CLAUDE.md content goes here so the model treats it as "reference info" not "iron law"
  if (config.userContext) {
    messages.push({ role: 'user', content: config.userContext })
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
        chatOptions.system = systemPromptStr
      } else if (config.tools) {
        chatOptions.system = systemPromptStr || messages[0]?.content
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
        yield { type: 'message', content, toolCalls: undefined, reasoningContent: response.reasoning }
        if (content) messages.push({ role: 'assistant', content, reasoning_content: response.reasoning })
        else if (thinking) messages.push({ role: 'assistant', content: rawContent, reasoning_content: response.reasoning })
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
      // Yield toolCalls so the caller can persist them on the assistant entry
      const nativeToolCalls = response.toolCalls?.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }))
      yield { type: 'message', content, toolCalls: nativeToolCalls, reasoningContent: response.reasoning }

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
          reasoning_content: response.reasoning,
        })
      } else if (content) {
        messages.push({ role: 'assistant', content, reasoning_content: response.reasoning })
      } else if (thinking) {
        messages.push({ role: 'assistant', content: rawContent, reasoning_content: response.reasoning })
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
          yield { type: 'tool', toolUse: { name: step.toolCall!.name, input: step.toolCall!.input as any }, toolResult: step.result!, toolCallId: step.toolCall?.apiId }
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
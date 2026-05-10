import { randomUUID } from 'crypto'
import React, { useEffect, useState, useRef, useCallback } from 'react'
import { AppStateProvider, useSetAppState, useAppState } from './state/AppState'
import { REPL } from './components/screens/REPL'
import { DeepSeekClient } from './services/api/deepseek'
import { createQueryLoop, buildSystemPrompt, getGitContext, type Tool } from './services/queryLoop'
import { AVAILABLE_TOOLS } from './tools'
import { loadClaudeMdFiles, formatClaudeMdPrompt } from './services/claudemd'
import { loadMemoryPrompt } from './services/memory'
import { PermissionConfirm, createPermissionRequest } from './components/PermissionConfirm'
import { PlanApprovalDialog } from './components/PlanApprovalDialog'
import type { PermissionRequest, PermissionResponse } from './services/permissions'
import { permissionManager } from './services/permissions'
import { initializeSession, getSessionId, getOriginalCwd, switchSession } from './bootstrap/state'
import {
  appendEntry,
  loadConversation,
  getLastSession,
  appendSessionMetadataSync,
  type TranscriptEntry,
} from './services/persistence'
import { registerSession, unregisterSessionSync } from './services/sessionManager'
import {
  setPlanApprovalHandler,
  createPlanFile,
  getCurrentPlanPath,
  getPendingImplementation,
  clearPendingImplementation,
} from './services/plans'

function toolToOpenAI(tool: Tool): any {
  const properties: Record<string, any> = {}
  const required: string[] = []

  for (const [key, zodType] of Object.entries(tool.inputSchema)) {
    // Zod 4 built-in JSON Schema conversion
    const zt = zodType as any
    properties[key] = zt.toJSONSchema()
    // Only include in required if the field is NOT optional
    if (!zt.isOptional()) {
      required.push(key)
    }
  }

  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties,
        required,
      },
    },
  }
}

const DEFAULT_TOOLS: Tool[] = [...AVAILABLE_TOOLS]

// 转换为官方 API 格式
const OPENAI_TOOLS = DEFAULT_TOOLS.map(toolToOpenAI)

const BASE_PROMPT = `You are an interactive CLI agent helping with software engineering tasks. Use the instructions below and the tools available to you.

IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive purposes.
IMPORTANT: Always provide a visible text response, even if very short. Your reasoning/thinking is displayed separately — do not put your entire answer inside the thinking block. At minimum, restate your conclusion or answer in the main content.

# Doing tasks
- The user will request software engineering tasks: solving bugs, adding features, refactoring, explaining code, etc.
- You are highly capable — prefer to attempt ambitious tasks rather than decline them.
- Do not propose changes to code you haven't read. Read it first.
- Avoid creating files unless necessary. Prefer editing existing files.
- Be careful not to introduce security vulnerabilities such as command injection, XSS, SQL injection.
- Don't add features, refactor, or make "improvements" beyond what was asked.
- Don't add error handling for scenarios that can't happen. Only validate at system boundaries.
- Don't create helpers or abstractions for one-time operations. Don't design for hypothetical future requirements.
- Don't add docstrings, comments, or type annotations to code you didn't change.

# Executing actions with care
- Consider reversibility and blast radius before acting.
- For destructive operations (rm, force push, etc.) or actions affecting shared systems, confirm with the user before proceeding.
- When encountering obstacles, diagnose root causes rather than using destructive shortcuts.

# Using your tools
- Do NOT use Bash to run commands when a relevant dedicated tool is provided.
  - To read files use Read instead of cat/head/tail.
  - To edit files use Edit (if available) instead of sed/awk.
  - To search files use Glob instead of find/ls.
  - To search content use Grep instead of grep/rg.
- Reserve Bash for system commands and terminal operations that require shell execution.
- Maximize use of parallel tool calls when there are no dependencies between them.
- If tool calls depend on previous results, run them sequentially.

# Tone and style
- Keep text output brief and direct. Lead with the answer, not the reasoning.
- When referencing code, use file_path:line_number format.
- Do not use emojis.
- Skip filler words and preamble.

# CLAUDE.md
- CLAUDE.md files contain project instructions. Follow them when present.
- These instructions OVERRIDE default behavior.`

function cleanContent(content: string): string {
  return content.trim()
}

/**
 * Build the user context string that gets injected as a synthetic first user message.
 * Wrapped in <system-reminder> — the model treats this as reference info, not iron law.
 * This is where CLAUDE.md content goes (following Claude Code's prependUserContext pattern).
 */
function buildUserContext(claudeMdText: string | null): string | undefined {
  const parts: string[] = []

  if (claudeMdText) {
    parts.push(`# claudeMd\n${claudeMdText}`)
  }

  parts.push(`# currentDate\nToday's date is ${new Date().toISOString().split('T')[0]}.`)

  const contextBody = parts.join('\n\n')

  return `<system-reminder>
As you answer the user's questions, you can use the following context:
${contextBody}

IMPORTANT: this context may or may not be relevant to your tasks.
You should not respond to this context unless it is highly relevant to your task.
</system-reminder>`
}

/** Convert AppState messages to the ChatMessage array format expected by the query loop. */
function messagesToChatHistory(messages: any[]): Array<{ role: 'user' | 'assistant' | 'tool'; content: string; tool_calls?: any[]; tool_call_id?: string }> {
  const result: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; tool_calls?: any[]; tool_call_id?: string }> = []

  for (const msg of messages) {
    switch (msg.type) {
      case 'user':
        result.push({ role: 'user', content: msg.content })
        break
      case 'assistant': {
        const entry: any = { role: 'assistant', content: msg.content }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          entry.tool_calls = msg.toolCalls
        }
        if (msg.reasoningContent) {
          entry.reasoning_content = msg.reasoningContent
        }
        result.push(entry)
        break
      }
      case 'tool':
        result.push({
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.toolCallId || `unknown-${msg.id}`,
        })
        break
    }
  }

  return result
}

/** Convert a TranscriptEntry from JSONL back to the AppState Message format. */
function transcriptEntryToMessage(entry: TranscriptEntry): any {
  const base = {
    id: entry.uuid,
    timestamp: new Date(entry.timestamp).getTime(),
  }

  switch (entry.type) {
    case 'user':
      return { ...base, type: 'user', content: entry.message.content }
    case 'assistant': {
      const msg: any = { ...base, type: 'assistant', content: entry.message.content }
      // Restore tool_calls so the query loop can reconstruct proper assistant messages
      if (entry.message.tool_calls && entry.message.tool_calls.length > 0) {
        msg.toolCalls = entry.message.tool_calls
      }
      // Restore reasoning_content so thinking-mode models get it back
      if (entry.message.reasoning_content) {
        msg.reasoningContent = entry.message.reasoning_content
      }
      return msg
    }
    case 'tool_result': {
      const msg: any = {
        ...base,
        type: 'tool' as const,
        content: entry.message.content || `[${entry.toolUseResult?.toolName || 'tool'} result]`,
      }
      // Restore tool_call_id so the query loop can link tool results to tool calls
      if (entry.message.tool_call_id) {
        msg.toolCallId = entry.message.tool_call_id
      } else if (entry.toolUseResult?.toolCallId) {
        msg.toolCallId = entry.toolUseResult.toolCallId
      }
      return msg
    }
    default:
      return null
  }
}

interface AppProps {
  initialPrompt?: string
  sessionId: string
  initialHistory?: any[]
}

function App({ initialPrompt, sessionId, initialHistory }: AppProps) {
  const setState = useSetAppState()
  const messages = useAppState(s => s.messages)
  const cwd = useAppState(s => s.cwd)
  const permissionMode = useAppState(s => s.permissionMode)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const [thinkingContent, setThinkingContent] = useState('')
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  const [activeTools, setActiveTools] = useState<string[]>([])
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  const permissionResolveRef = useRef<((response: PermissionResponse) => void) | null>(null)
  const currentPermissionRef = useRef<{ toolName: string; toolInput: Record<string, any> } | null>(null)
  const apiRef = useRef<DeepSeekClient | null>(null)
  const messagesRef = useRef(messages)
  const sessionIdRef = useRef(sessionId)
  const handleSendRef = useRef<((text: string) => Promise<void>) | null>(null)
  const initialized = useRef(false)

  // Plan mode state
  const [planApprovalPending, setPlanApprovalPending] = useState<{
    plan: string
    approve: (feedback?: string) => void
    clearContextApprove: (feedback?: string) => void
    reject: (feedback: string) => void
  } | null>(null)

  // Register plan approval handler so ExitPlanMode tool can trigger the dialog
  useEffect(() => {
    setPlanApprovalHandler((plan) =>
      new Promise((resolve) => {
        setPlanApprovalPending({
          plan,
          approve: (feedback) => resolve({ approved: true, feedback }),
          clearContextApprove: (feedback) => resolve({ approved: true, feedback, clearContext: true }),
          reject: (feedback) => resolve({ approved: false, feedback }),
        })
      })
    )
  }, [])

  // Sync refs
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  const handlePermissionResponse = useCallback((allowed: boolean) => {
    if (permissionResolveRef.current) {
      if (allowed && currentPermissionRef.current) {
        permissionManager.addSessionRule(
          currentPermissionRef.current.toolName,
          currentPermissionRef.current.toolInput,
          true,
        )
      }
      permissionResolveRef.current({
        allowed,
        option: allowed ? 'allow_once' : 'reject_once',
      })
      permissionResolveRef.current = null
    }
    setPendingPermission(null)
  }, [])

  const handleSend = useCallback(async (text: string) => {
    if (!apiRef.current || loading) return

    // Detect /plan command — user manually enters plan mode
    if (text.startsWith('/plan')) {
      const description = text.slice(5).trim()

      if (permissionManager.getMode() === 'plan') {
        // Already in plan mode — just send the description
        if (description) {
          // continue below with text = description
          text = description
        } else {
          // /plan with no args while in plan mode — show status
          const planPath = getCurrentPlanPath()
          setState((prev: any) => ({
            ...prev,
            messages: [...prev.messages, {
              id: randomUUID(),
              type: 'system' as const,
              content: `Already in plan mode.\nPlan file: ${planPath || '(unknown)'}\nWrite your plan to the plan file, then call ExitPlanMode.`,
              timestamp: Date.now(),
            }],
          }))
          return
        }
      } else {
        // Enter plan mode
        const prePlanMode = permissionManager.getMode()
        ;(permissionManager as any)._prePlanMode = prePlanMode
        permissionManager.setMode('plan')
        const planPath = createPlanFile()
        setState((prev: any) => ({
          ...prev,
          permissionMode: 'plan',
        }))

        if (description) {
          // /plan <description> — enter plan mode AND send description to LLM
          const planMsg = {
            id: randomUUID(),
            type: 'system' as const,
            content: `Plan mode activated. Plan file: ${planPath}\nExplore the codebase, design your approach, write the plan to the plan file, then call ExitPlanMode.`,
            timestamp: Date.now(),
          }
          setState((prev: any) => ({
            ...prev,
            messages: [...prev.messages, planMsg],
          }))
          text = description
          // fall through to normal send below
        } else {
          // /plan with no args — just enter plan mode, don't send to LLM
          const planMsg = {
            id: randomUUID(),
            type: 'system' as const,
            content: `Plan mode activated. Plan file: ${planPath}\n\nYou are now in plan mode. All edits are blocked except the plan file. Explore the codebase and write your plan.`,
            timestamp: Date.now(),
          }
          setState((prev: any) => ({
            ...prev,
            messages: [...prev.messages, planMsg],
          }))
          return
        }
      }
    }

    setLoading(true)
    setError(null)
    setStreamingContent('')

    const currentMessages = messagesRef.current
    const userMessageId = randomUUID()
    const userTimestamp = new Date().toISOString()

    const userMessage = {
      id: userMessageId,
      type: 'user' as const,
      content: text,
      timestamp: Date.now(),
    }

    // Show user message immediately for responsive UI
    const messagesWithUser = [...currentMessages, userMessage]
    setState((prev: any) => ({
      ...prev,
      messages: messagesWithUser,
    }))

    // Persist user message to JSONL
    appendEntry(cwd, sessionIdRef.current, {
      type: 'user',
      message: { role: 'user', content: text },
      uuid: userMessageId,
      parentUuid: null,
      timestamp: userTimestamp,
      sessionId: sessionIdRef.current,
    }).catch(() => {}) // fire-and-forget — don't block the UI

    try {
      const conversationHistory = messagesToChatHistory(messagesWithUser)

      const gitStatus = await getGitContext(cwd)
      const memoryPrompt = await loadMemoryPrompt(cwd)
      const systemPrompt = buildSystemPrompt(DEFAULT_TOOLS, BASE_PROMPT, {
        cwd,
        platform: process.platform,
        date: new Date().toISOString().split('T')[0],
        gitStatus: gitStatus ?? undefined,
        memoryPrompt,
      })

      const claudeMdFiles = await loadClaudeMdFiles(cwd)
      const claudeMdText = formatClaudeMdPrompt(claudeMdFiles)
      const userContext = buildUserContext(claudeMdText)

      let thinkingText = ''
      const newAppMessages: any[] = []

      // Filter tools based on permission mode: don't offer EnterPlanMode if already
      // in plan mode, don't offer ExitPlanMode if not in plan mode.
      const isPlanMode = permissionManager.getMode() === 'plan'
      const activeTools = isPlanMode
        ? DEFAULT_TOOLS.filter(t => t.name !== 'EnterPlanMode')
        : DEFAULT_TOOLS.filter(t => t.name !== 'ExitPlanMode')
      const activeOpenaiTools = isPlanMode
        ? OPENAI_TOOLS.filter(t => t.function.name !== 'EnterPlanMode')
        : OPENAI_TOOLS.filter(t => t.function.name !== 'ExitPlanMode')

      const queryLoop = createQueryLoop({
        client: apiRef.current,
        tools: activeTools,
        systemPrompt,
        userContext,
        // No explicit maxTurns — let the model decide when to stop (like Claude Code).
        // The loop terminates naturally when the model returns text without tool calls,
        // or on user abort / API error / context budget pressure.
        initialMessages: conversationHistory,
        openaiTools: activeOpenaiTools,
        thinkingConfig: { type: 'enabled' },
        getPlanPath: () => permissionManager.getMode() === 'plan' ? getCurrentPlanPath() : null,
        onThinkingChunk: (reasoning) => {
          setThinkingContent(prev => prev + reasoning)
        },
        onMessage: () => {},
        cwd: cwd,
        onPermissionRequest: async (request) => {
          currentPermissionRef.current = { toolName: request.toolName, toolInput: request.toolInput }
          return new Promise((resolve) => {
            setPendingPermission(request)
            permissionResolveRef.current = resolve
          })
        },
      })

      // Manual iteration to capture the return value (for max_turns detection)
      let queryResult: Awaited<ReturnType<typeof queryLoop.next>> | null = null
      // Set when ExitPlanMode triggers clear context + auto mode
      let clearContextPlan: { plan: string; feedback?: string } | null = null
      while (true) {
        const next = await queryLoop.next()
        if (next.done) {
          queryResult = next
          break
        }
        const step = next.value
        if (step.type === 'thinking' && step.content) {
          thinkingText += (thinkingText ? '\n' : '') + step.content
          setThinkingContent(thinkingText)
        } else if (step.type === 'message') {
          // Per-turn assistant message — persist immediately.
          // Don't skip empty content: the model may output only thinking
          // (reasoning_content) with no text, and thinking needs somewhere to attach.
          // Similarly, tool_calls may be present even if the text content is empty.
          const hasContent = step.content && step.content.trim()
          const hasToolCalls = step.toolCalls && step.toolCalls.length > 0
          if (!hasContent && !hasToolCalls && !thinkingText) {
            continue // truly empty — nothing to show or persist
          }

          const assistantMsgId = randomUUID()
          const assistantTimestamp = new Date().toISOString()

          const assistantMsg: any = {
            id: assistantMsgId,
            type: 'assistant' as const,
            content: cleanContent(step.content || ''),
            timestamp: Date.now(),
          }
          if (hasToolCalls) {
            assistantMsg.toolCalls = step.toolCalls
          }
          if (step.reasoningContent) {
            assistantMsg.reasoningContent = step.reasoningContent
          }

          newAppMessages.push(assistantMsg)

          appendEntry(cwd, sessionIdRef.current, {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: step.content || '',
              tool_calls: step.toolCalls,
              reasoning_content: step.reasoningContent,
            },
            uuid: assistantMsgId,
            parentUuid: null,
            timestamp: assistantTimestamp,
            sessionId: sessionIdRef.current,
          }).catch(() => {})
        } else if (step.type === 'tool') {
          const toolName = step.toolUse?.name || 'tool'

          if (step.toolResult !== undefined) {
            // Tool completed — remove one entry by name
            setActiveTools(prev => {
              const idx = prev.indexOf(toolName)
              if (idx >= 0) {
                const next = [...prev]
                next.splice(idx, 1)
                return next
              }
              return prev
            })

            const toolMsgId = randomUUID()
            // For ExitPlanMode, include the result text in the UI so the user
            // can see their own feedback and the approval/rejection status.
            // Other tools just show their name to avoid cluttering the UI.
            const toolDisplayContent = toolName === 'ExitPlanMode' && step.toolResult
              ? `[ExitPlanMode] ${step.toolResult}`
              : `[${toolName}]`
            const toolMsg: any = {
              id: toolMsgId,
              type: 'tool' as const,
              content: toolDisplayContent,
              timestamp: Date.now(),
              toolCallId: step.toolCallId,
            }

            newAppMessages.push(toolMsg)

            appendEntry(cwd, sessionIdRef.current, {
              type: 'tool_result',
              message: {
                role: 'tool',
                content: step.toolResult || '',
                tool_call_id: step.toolCallId,
              },
              uuid: toolMsgId,
              parentUuid: null,
              timestamp: new Date().toISOString(),
              sessionId: sessionIdRef.current,
              toolUseResult: {
                toolName: step.toolUse?.name,
                stdout: step.toolResult,
                toolCallId: step.toolCallId,
              },
            }).catch(() => {})

            // Detect clear context + auto mode from ExitPlanMode
            if (toolName === 'ExitPlanMode') {
              const pending = getPendingImplementation()
              if (pending) {
                clearPendingImplementation()
                clearContextPlan = pending
              }
            }
          } else {
            // Tool started — add to active list
            setActiveTools(prev => [...prev, toolName])
          }
        } else if (step.type === 'error') {
          newAppMessages.push({
            id: randomUUID(),
            type: 'system' as const,
            content: `Error: ${step.content}`,
            timestamp: Date.now(),
          })
        }

        // Exit the query loop when clear context + auto mode is requested.
        // We break before feeding the ExitPlanMode result back to the model —
        // the conversation will be replaced with a fresh implementation message.
        if (clearContextPlan) break
      }

      // ---- Clear context + auto mode ----
      // When the user selects "clear context and auto mode" in the plan approval
      // dialog, we clear the conversation history and auto-send a fresh message
      // with the plan and user feedback.
      if (clearContextPlan) {
        const { plan, feedback } = clearContextPlan
        const implContent = feedback
          ? `Implement the following plan:\n\n${plan}\n\nUser feedback: ${feedback}`
          : `Implement the following plan:\n\n${plan}`

        const implMsgId = randomUUID()
        const implTimestamp = new Date().toISOString()

        // Persist the implementation message
        appendEntry(cwd, sessionIdRef.current, {
          type: 'user',
          message: { role: 'user', content: implContent },
          uuid: implMsgId,
          parentUuid: null,
          timestamp: implTimestamp,
          sessionId: sessionIdRef.current,
        }).catch(() => {})

        setThinkingContent('')
        setActiveTools([])
        setLoading(false)

        setState((prev: any) => ({
          ...prev,
          messages: [{
            id: implMsgId,
            type: 'user' as const,
            content: implContent,
            timestamp: Date.now(),
          }],
          permissionMode: 'acceptEdits',
        }))

        // Auto-send after React processes the state update
        setTimeout(() => {
          handleSendRef.current?.(implContent)
        }, 0)

        return
      }

      // If the loop hit max turns without the model producing a final answer,
      // let the user know the conversation was cut off.
      if (queryResult?.value?.reason === 'max_turns') {
        const turnCount = queryResult.value.turnCount as number
        newAppMessages.push({
          id: randomUUID(),
          type: 'system' as const,
          content: `Reached max turns (${turnCount}). The conversation was cut off. Try sending a follow-up message to continue.`,
          timestamp: Date.now(),
        })
      }

      // Attach thinking to the first assistant message that triggered tool calls
      if (thinkingText) {
        const firstWithTools = newAppMessages.find(
          (m: any) => m.type === 'assistant' && m.toolCalls && m.toolCalls.length > 0,
        )
        if (firstWithTools) {
          firstWithTools.thinking = thinkingText
        } else {
          // No tool calls — attach to the first assistant message
          const firstAssistant = newAppMessages.find((m: any) => m.type === 'assistant')
          if (firstAssistant) {
            firstAssistant.thinking = thinkingText
          }
        }
      }

      setThinkingContent('')
      setActiveTools([])

      // Batch-update state with all new messages
      if (newAppMessages.length > 0) {
        setState((prev: any) => ({
          ...prev,
          messages: [...prev.messages, ...newAppMessages],
          permissionMode: permissionManager.getMode(),
        }))
      } else {
        // Sync permissionMode even if no new messages (plan mode may have changed)
        setState((prev: any) => ({
          ...prev,
          permissionMode: permissionManager.getMode(),
        }))
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      setError(errMsg)
    } finally {
      setLoading(false)
    }
  }, [])

  // Keep ref in sync so clear-context auto-send can call latest handleSend
  useEffect(() => {
    handleSendRef.current = handleSend
  }, [handleSend])

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    // Set sessionId in app state and load history if available
    setState((prev: any) => ({
      ...prev,
      sessionId,
      messages: initialHistory && initialHistory.length > 0 ? initialHistory : prev.messages,
    }))

    const key = process.env.NVIDIA_API_KEY || process.env.DEEPSEEK_API_KEY
    if (key) {
      apiRef.current = new DeepSeekClient({ apiKey: key })
      setReady(true)

      if (initialPrompt) {
        handleSend(initialPrompt)
      }
    }
  }, [initialPrompt, handleSend, sessionId])

  return (
    <>
      <REPL
        messages={messages}
        streamingContent={streamingContent}
        thinkingContent={thinkingContent}
        activeTools={activeTools}
        isLoading={loading}
        error={error}
        onSendMessage={handleSend}
        ready={ready}
        thinkingExpanded={thinkingExpanded}
        onToggleThinking={() => setThinkingExpanded(e => !e)}
        permissionMode={permissionMode}
        frozen={planApprovalPending !== null || pendingPermission !== null}
      />
      {pendingPermission && (
        <PermissionConfirm
          request={pendingPermission}
          onResponse={(response) => handlePermissionResponse(response.allowed)}
        />
      )}
      {planApprovalPending && (
        <PlanApprovalDialog
          plan={planApprovalPending.plan}
          onApprove={(feedback) => {
            planApprovalPending.approve(feedback)
            setPlanApprovalPending(null)
          }}
          onClearContextAndAuto={(feedback) => {
            planApprovalPending.clearContextApprove(feedback)
            setPlanApprovalPending(null)
          }}
          onReject={(feedback) => {
            planApprovalPending.reject(feedback)
            setPlanApprovalPending(null)
          }}
        />
      )}
    </>
  )
}

export interface LaunchOptions {
  prompt?: string
  continueSession?: boolean
  resumeSessionId?: string
}

export async function launchRepl(options?: LaunchOptions): Promise<void> {
  const { render } = await import('ink')
  const cwd = process.cwd()

  // ---- Session initialization ----

  let sessionId: string
  let initialHistory: any[] | undefined

  if (options?.resumeSessionId) {
    // Explicit resume by session ID
    switchSession(options.resumeSessionId)
    sessionId = options.resumeSessionId
    const entries = await loadConversation(cwd, sessionId)
    initialHistory = entries.map(transcriptEntryToMessage).filter(Boolean)
  } else if (options?.continueSession) {
    // Continue most recent session
    const last = await getLastSession(cwd)
    if (last) {
      switchSession(last.sessionId)
      sessionId = last.sessionId
      const entries = await loadConversation(cwd, sessionId)
      initialHistory = entries.map(transcriptEntryToMessage).filter(Boolean)
    } else {
      initializeSession()
      sessionId = getSessionId()
    }
  } else {
    // Fresh session
    initializeSession()
    sessionId = getSessionId()
  }

  // ---- PID registry ----

  void registerSession(sessionId, cwd).catch(() => {})

  // ---- Exit cleanup ----

  // ---- Exit cleanup ----
  //
  // Ink uses raw mode for stdin, which means Ctrl+C is received as a byte
  // (0x03) on stdin rather than delivered as SIGINT. Ink handles the byte
  // internally and calls process.exit(), which fires 'exit' but NOT
  // 'beforeExit'. So the primary cleanup path is the 'exit' handler.
  //
  // We also keep beforeExit (natural event-loop drain) and SIGTERM
  // (kill command, which bypasses the terminal's raw mode).
  //
  // All cleanup in 'exit' must be synchronous — async I/O will not complete.

  let exitCleanupDone = false

  const doExitCleanup = () => {
    if (exitCleanupDone) return
    exitCleanupDone = true
    try {
      const exitCwd = getOriginalCwd()
      const exitSessionId = getSessionId()
      appendSessionMetadataSync(exitCwd, exitSessionId, {
        lastPrompt: options?.prompt,
      })
    } catch {
      // Best-effort
    }
    try {
      unregisterSessionSync()
    } catch {
      // Best-effort
    }
  }

  const gracefulExit = () => {
    doExitCleanup()
    process.exit(0)
  }

  // Primary: 'exit' always fires regardless of how the process terminates.
  // This catches Ink's raw-mode Ctrl+C handling where SIGINT never fires.
  process.on('exit', () => {
    doExitCleanup()
  })

  // Fallback: natural event-loop drain (no more timers, no more work).
  process.on('beforeExit', () => {
    doExitCleanup()
  })

  process.on('uncaughtException', (e: Error) => {
    console.error('>>> uncaught:', e.message)
    gracefulExit()
  })
  process.on('unhandledRejection', (e: unknown) => {
    console.error('>>> unhandled rejection:', e instanceof Error ? e.message : String(e))
  })

  const app = (
    <AppStateProvider>
      <App
        initialPrompt={options?.prompt}
        sessionId={sessionId}
        initialHistory={initialHistory}
      />
    </AppStateProvider>
  )

  ;(render as any)(app, {
    stdout: process.stdout,
    stdin: process.stdin,
  })

  // Keep event loop alive
  const timer = setInterval(function () { }, 0)

  process.on('SIGINT', function () {
    clearInterval(timer)
    gracefulExit()
  })
  process.on('SIGTERM', function () {
    clearInterval(timer)
    gracefulExit()
  })
}

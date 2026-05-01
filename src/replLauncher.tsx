import { z } from 'zod'
import React, { useEffect, useState, useRef, useCallback } from 'react'
import { AppStateProvider, useSetAppState, useAppState } from './state/AppState'
import { REPL } from './components/screens/REPL'
import { DeepSeekClient } from './services/api/deepseek'
import { createQueryLoop, buildSystemPrompt, type Tool } from './services/queryLoop'
import { AVAILABLE_TOOLS } from './tools'
import { PermissionConfirm, createPermissionRequest } from './components/PermissionConfirm'
import type { PermissionRequest, PermissionResponse } from './services/permissions'
import { permissionManager } from './services/permissions'

function toolToOpenAI(tool: Tool): any {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: tool.inputSchema,
        required: Object.keys(tool.inputSchema),
      },
    },
  }
}

const DEFAULT_TOOLS: Tool[] = [
  {
    name: 'calculate',
    description: 'Evaluate math expressions',
    inputSchema: { expression: z.string() },
    execute: async ({ expression }: any) => {
      try {
        const result = Function(`"use strict"; return (${expression})`)()
        return String(result)
      } catch (e: any) {
        return `Error: ${e.message}`
      }
    },
  },
  ...AVAILABLE_TOOLS,
]

// 转换为官方 API 格式
const OPENAI_TOOLS = DEFAULT_TOOLS.map(toolToOpenAI)

const BASE_PROMPT = `You are an interactive CLI agent helping with software engineering tasks. Use the instructions below and the tools available to you.

IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive purposes.

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

# Auto memory
- You have a persistent memory system at ~/.claude/projects/<project>/memory/.
- Build it up so future conversations have context about the user's preferences and project.
- Save user preferences, project facts, feedback on your approach.
- Organize memory semantically, not chronologically.

# CLAUDE.md
- CLAUDE.md files contain project instructions. Follow them when present.
- These instructions OVERRIDE default behavior.`

function cleanContent(content: string): string {
  return content.trim()
}

function App({ initialPrompt }: { initialPrompt?: string }) {
  const setState = useSetAppState()
  const messages = useAppState(s => s.messages)
  const cwd = useAppState(s => s.cwd)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const [thinkingContent, setThinkingContent] = useState('')
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  const [currentTool, setCurrentTool] = useState<string | null>(null)
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  const permissionResolveRef = useRef<((response: PermissionResponse) => void) | null>(null)
  const currentPermissionRef = useRef<{ toolName: string; toolInput: Record<string, any> } | null>(null)
  const apiRef = useRef<DeepSeekClient | null>(null)
  const messagesRef = useRef(messages)
  const initialized = useRef(false)

  // 同步 messages 到 ref
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const handlePermissionResponse = useCallback((allowed: boolean) => {
    if (permissionResolveRef.current) {
      // Remember permission to avoid re-prompting the same tool+input this session
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

    setLoading(true)
    setError(null)
    setStreamingContent('')

    // 使用 ref 获取消息
    const currentMessages = messagesRef.current
    
    const userMessage = { 
      id: Date.now().toString(), 
      type: 'user' as const, 
      content: text, 
      timestamp: Date.now() 
    }
    
    // 添加用户消息
    const allMessages = [...currentMessages, userMessage]
    setState((prev: any) => ({
      ...prev,
      messages: allMessages,
    }))

    try {
      const conversationHistory = [...allMessages.map((msg: any) => ({
        role: msg.type === 'user' ? 'user' as const : 'assistant' as const,
        content: msg.content,
      }))]

      const systemPrompt = buildSystemPrompt(DEFAULT_TOOLS, BASE_PROMPT, {
        cwd,
        platform: process.platform,
        date: new Date().toISOString().split('T')[0],
      })

      let fullContent = ''
      let thinkingText = ''
      let toolMessages: any[] = []

      const queryLoop = createQueryLoop({
        client: apiRef.current,
        tools: DEFAULT_TOOLS,
        systemPrompt,
        maxTurns: 5,
        initialMessages: conversationHistory,
        openaiTools: OPENAI_TOOLS,
        thinkingConfig: { type: 'enabled' },
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

      let stepCount = 0
      for await (const step of queryLoop) {
        stepCount++
        if (step.type === 'thinking' && step.content) {
          thinkingText += (thinkingText ? '\n' : '') + step.content
          setThinkingContent(thinkingText)
        } else if (step.type === 'message' && step.content) {
          fullContent += step.content + '\n'
        } else if (step.type === 'tool') {
          setCurrentTool(step.toolUse?.name || null)
          if (step.toolResult) {
            toolMessages.push({
              id: Date.now().toString() + Math.random(),
              type: 'tool' as const,
              content: `tool called message: [${step.toolUse?.name}: ${step.toolResult}]`,
              timestamp: Date.now()
            })

            // 更新完整内容（包含工具调用和结果）
            if (step.toolUse) {
              fullContent += `\n used [Tool: ${step.toolUse.name}, Input: ${JSON.stringify(step.toolUse.input || {})}]\n`
            }
          }
        } else if (step.type === 'permission') {
          // 权限步骤已被 handlePermissionResponse 处理
        } else if (step.type === 'error') {
          fullContent += `\nError: ${step.content}\n`
        }
      }

      setThinkingContent('')
      setCurrentTool(null)

      // 如果没有 assistant 内容但有 tool 结果，使用 tool 结果作为回复
      const finalContent = fullContent.trim() || (toolMessages.length > 0 
        ? toolMessages.map(m => m.content).join('\n') 
        : '')
      
      if (!finalContent) {
        // 没有内容，直接返回，不添加空消息
        setState((prev: any) => ({
          ...prev,
          messages: [...prev.messages, ...toolMessages],
        }))
        return
      }
      
      const assistantMessage = {
        id: Date.now().toString(),
        type: 'assistant' as const,
        content: cleanContent(finalContent),
        thinking: thinkingText || undefined,
        timestamp: Date.now()
      }
      
      setState((prev: any) => ({
        ...prev,
        messages: [...prev.messages, ...toolMessages, assistantMessage],
      }))
      
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      setError(errMsg)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    const key = process.env.NVIDIA_API_KEY || process.env.DEEPSEEK_API_KEY
    if (key) {
      apiRef.current = new DeepSeekClient({ apiKey: key })
      setReady(true)

      if (initialPrompt) {
        handleSend(initialPrompt)
      }
    }
  }, [initialPrompt, handleSend])

  return (
    <>
      {pendingPermission && (
        <PermissionConfirm
          request={pendingPermission}
          onResponse={(response) => handlePermissionResponse(response.allowed)}
        />
      )}
      <REPL
        messages={messages}
        streamingContent={streamingContent}
        thinkingContent={thinkingContent}
        currentTool={currentTool}
        isLoading={loading}
        error={error}
        onSendMessage={handleSend}
        ready={ready}
        thinkingExpanded={thinkingExpanded}
        onToggleThinking={() => setThinkingExpanded(e => !e)}
      />
    </>
  )
}

export async function launchRepl(options?: { prompt?: string; continue?: boolean }): Promise<void> {
  const { render } = await import('ink')

  // 监听所有可能的退出事件
  const beforeExit = () => console.error('>>> beforeExit')
  const exit = (code: number) => console.error('>>> exit:', code)
  const uncaught = (e: Error) => console.error('>>> uncaught:', e.message)
  
  process.on('beforeExit', beforeExit)
  process.on('exit', exit)
  process.on('uncaughtException', uncaught)
  process.on('unhandledRejection', uncaught)
  
  const app = (
    <AppStateProvider>
      <App initialPrompt={options?.prompt} />
    </AppStateProvider>
  )

  ;(render as any)(app, {
    stdout: process.stdout,
    stdin: process.stdin,
  })

  // 保持定时器活跃
  const timer = setInterval(function() {}, 0)
  
  // 允许 Ctrl+C 退出
  process.on('SIGINT', function() {
    clearInterval(timer)
    process.exit(0)
  })
  process.on('SIGTERM', function() {
    clearInterval(timer)
    process.exit(0)
  })
}
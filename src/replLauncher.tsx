import { z } from 'zod'
import React, { useEffect, useState, useRef, useCallback } from 'react'
import { AppStateProvider, useSetAppState, useAppState } from './state/AppState'
import { REPL } from './components/screens/REPL'
import { DeepSeekClient } from './services/api/deepseek'
import { createQueryLoop, type Tool } from './services/queryLoop'

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
]

// 转换为官方 API 格式
const OPENAI_TOOLS = DEFAULT_TOOLS.map(toolToOpenAI)

const BASE_PROMPT = `You are a helpful AI assistant. You have access to a "calculate" tool that can evaluate math expressions.
IMPORTANT: When a math problem is given, ALWAYS use the calculate tool. Do NOT calculate manually or provide step-by-step reasoning in your response.
Just call the tool and return the result.`

function cleanContent(content: string): string {
  return content.trim()
}

function App({ initialPrompt }: { initialPrompt?: string }) {
  const setState = useSetAppState()
  const messages = useAppState(s => s.messages)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const [thinkingContent, setThinkingContent] = useState('')
  const [currentTool, setCurrentTool] = useState<string | null>(null)
  const apiRef = useRef<DeepSeekClient | null>(null)
  const messagesRef = useRef(messages)
  const initialized = useRef(false)

  // 同步 messages 到 ref
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

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

      let fullContent = ''
      let toolMessages: any[] = []
      
      const queryLoop = createQueryLoop({
        client: apiRef.current,
        tools: DEFAULT_TOOLS,
        systemPrompt: BASE_PROMPT,
        maxTurns: 5,
        initialMessages: conversationHistory,
        openaiTools: OPENAI_TOOLS,  // 使用官方 API tools
        onMessage: () => {},
      })

      let stepCount = 0
      for await (const step of queryLoop) {
        stepCount++
        if (step.type === 'thinking' && step.content) {
          setThinkingContent(step.content)
        } else if (step.type === 'message' && step.content) {
          fullContent += step.content + '\n'
        } else if (step.type === 'tool') {
          setCurrentTool(step.toolUse?.name || null)
        if (step.toolResult) {
          toolMessages.push({
            id: Date.now().toString() + Math.random(),
            type: 'tool' as const,
            content: `[${step.toolUse?.name}: ${step.toolResult}]`,
            timestamp: Date.now()
          })
          
          // 更新完整内容（包含工具调用和结果）
          if (step.toolUse) {
            fullContent += `\n[Tool: ${step.toolUse.name} = ${step.toolResult}]`
          }
        }
      } else if (step.type === 'message' && step.content) {
        fullContent += step.content + '\n'
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
    <REPL 
      messages={messages}
      streamingContent={streamingContent}
      thinkingContent={thinkingContent}
      currentTool={currentTool}
      isLoading={loading}
      error={error}
      onSendMessage={handleSend}
      ready={ready}
    />
  )
}

export async function launchRepl(options?: { prompt?: string; continue?: boolean }): Promise<void> {
  const { render } = await import('ink')
  
  const app = (
    <AppStateProvider>
      <App initialPrompt={options?.prompt} />
    </AppStateProvider>
  )

  ;(render as any)(app, {
    stdout: process.stdout,
    stdin: process.stdin,
  })

  await new Promise(() => {})
}
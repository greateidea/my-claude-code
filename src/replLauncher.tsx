import { z } from 'zod'
import React, { useEffect, useState, useRef, useCallback } from 'react'
import { AppStateProvider, useSetAppState, useAppState } from './state/AppState'
import { REPL } from './components/screens/REPL'
import { DeepSeekClient } from './services/api/deepseek'
import { createQueryLoop, type Tool, buildSystemPrompt } from './services/queryLoop'

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

const BASE_PROMPT = `You are a helpful AI assistant. You have a "calculate" tool for math.

STRICT Rules:
1. You MUST use <thinking> tags for ALL reasoning
2. You MUST call calculate tool for math problems
3. Never calculate in your head

Use this format ALWAYS:

First, your thinking:
<thinking>
Step 1: 1+5*2 = 1+10 = 11
Step 2: 5*20/10 = 100/10 = 10
Step 3: 10*50 = 500
Step 4: 100*2 = 200
Step 5: 11 + 10 - 500 + 200 = -279
</thinking>

Then, call the tool:
<tool_call>
<tool name="calculate">
<param name="expression">1+5*2+5*20/10-10*50+100*2</param>
</tool_call>

Finally, give the answer based on tool result.`

function cleanContent(content: string): string {
  // 去除 XML 标签（只在最终存储时）
  return content
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool name="[^"]*">[\s\S]*?<\/tool>/g, '')
    .replace(/<param name="([^"]+)">([^<]+)<\/param>/g, '$2 ')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim()
}

const SYSTEM_PROMPT = buildSystemPrompt(DEFAULT_TOOLS, BASE_PROMPT)

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
        systemPrompt: SYSTEM_PROMPT,
        maxTurns: 5,
        initialMessages: conversationHistory,
        onMessage: () => {},  // 不使用 onMessage，避免重复
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
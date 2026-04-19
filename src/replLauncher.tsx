import React, { useEffect, useState, useRef } from 'react'
import { AppStateProvider, useSetAppState, useAppState } from './state/AppState'
import { REPL } from './components/screens/REPL'
import { DeepSeekClient } from './services/api/deepseek'

function App({ initialPrompt }: { initialPrompt?: string }) {
  const setState = useSetAppState()
  const messages = useAppState(s => s.messages)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const apiRef = useRef<DeepSeekClient | null>(null)
  const initialized = useRef(false)

  const handleSend = async (text: string) => {
    if (!apiRef.current) return

    setLoading(true)
    setError(null)

    setState((prev: any) => ({
      ...prev,
      messages: [...prev.messages, { id: Date.now().toString(), type: 'user', content: text, timestamp: Date.now() }],
    }))

    try {
      const response = await apiRef.current.chat({
        messages: [{ role: 'user', content: text }],
        maxTokens: 500,
      })

      setState((prev: any) => ({
        ...prev,
        messages: [...prev.messages, { id: Date.now().toString(), type: 'assistant', content: response.message.content, timestamp: Date.now() }],
      }))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

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
  }, [initialPrompt])

  return (
    <REPL 
      messages={messages}
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
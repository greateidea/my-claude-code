import React, { useState, useEffect, useRef, memo } from 'react'
import { Box, Text } from 'ink'

interface PromptInputProps {
  onSubmit: (text: string) => void
  disabled?: boolean
}

const Cursor = memo(function Cursor() {
  const [visible, setVisible] = useState(true)
  
  useEffect(() => {
    const interval = setInterval(() => {
      setVisible(v => !v)
    }, 530)
    return () => clearInterval(interval)
  }, [])
  
  return <Text bold color="white">{visible ? '█' : ' '}</Text>
})
Cursor.displayName = 'Cursor'

export function PromptInput({ onSubmit, disabled = false }: PromptInputProps) {
  const [input, setInput] = useState('')
  const [isTTY, setIsTTY] = useState(false)
  const inputRef = useRef(input)

  useEffect(() => {
    inputRef.current = input
  }, [input])

  useEffect(() => {
    setIsTTY(process.stdin.isTTY === true)
  }, [])

  useEffect(() => {
    if (!isTTY || disabled) return

    const handleData = (chunk: Buffer) => {
      const char = chunk.toString()
      const currentInput = inputRef.current
      
      if (char === '\r' || char === '\n') {
        if (currentInput.trim()) {
          onSubmit(currentInput)
          setInput('')
        }
        return
      }
      
      if (char === '\x03') {
        process.exit(0)
        return
      }
      
      if (char === '\x7f' || char === '\x08') {
        setInput(prev => prev.slice(0, -1))
        return
      }
      
      if (char.startsWith('\x1b')) {
        return
      }
      
      if (char.length > 0) {
        setInput(prev => prev + char)
      }
    }

    try {
      ;(process.stdin as any).setRawMode?.(true)
      process.stdin.resume()
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', handleData)
    } catch (e) {
      setIsTTY(false)
    }

    return () => {
      try {
        ;(process.stdin as any).setRawMode?.(false)
        process.stdin.pause()
        process.stdin.removeListener('data', handleData)
      } catch (e) {}
    }
  }, [isTTY, disabled])

  if (!isTTY || disabled) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold color="cyan">{'>'}</Text>
          <Text> </Text>
          <Text color="gray">(Non-interactive - use bun run chat Hi)</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">{'>'}</Text>
        <Text> </Text>
        <Text color={input ? 'white' : 'gray'}>
          {input || '(type message)...'}
        </Text>
        <Cursor />
      </Box>
      <Text dimColor>Press Enter to send, Ctrl+C to exit</Text>
    </Box>
  )
}
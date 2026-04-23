import React, { useState, useEffect, useRef } from 'react'
import { Box, Text } from 'ink'

interface PromptInputProps {
  onSubmit: (text: string) => void
  disabled?: boolean
}

export function PromptInput({ onSubmit, disabled = false }: PromptInputProps) {
  const [input, setInput] = useState('')
  const [isTTY, setIsTTY] = useState(false)

  useEffect(() => {
    setIsTTY(process.stdin.isTTY === true)
  }, [])

  const [cursorChar, setCursorChar] = useState('|')
  const inputRef = useRef(input)

  useEffect(() => {
    inputRef.current = input
  }, [input])

  useEffect(() => {
    if (!isTTY || disabled) return

    // 减慢到1秒，减少重新渲染频率
    const interval = setInterval(() => {
      setCursorChar(c => c === '|' ? '█' : '|')
    }, 1000)

    return () => clearInterval(interval)
  }, [isTTY, disabled])

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
        // 方向键等 escape 序列，忽略而不是退出
        return
      }
      
      if (char.length > 0) {
        setInput(prev => prev + char)
      }
    }

    try {
      (process.stdin as any).setRawMode?.(true)
      process.stdin.resume()
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', handleData)
    } catch (e) {
      setIsTTY(false)
    }

    return () => {
      try {
        (process.stdin as any).setRawMode?.(false)
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
        <Text bold color="white">{cursorChar}</Text>
      </Box>
      <Text dimColor>Press Enter to send, Ctrl+C to exit</Text>
    </Box>
  )
}
import React, { useState, useEffect, useRef } from 'react'
import { Box, Text } from 'ink'

interface PromptInputProps {
  onSubmit: (text: string) => void
  disabled?: boolean
}

// 不使用动态闪烁，避免 Ink 重新渲染整个树
function StaticCursor() {
  return <Text bold color="white">▌</Text>
}

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
        // Ctrl+C — exit on empty input, clear otherwise
        if (!currentInput.trim()) {
          process.exit(0)
        }
        setInput('')
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
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', handleData)
    } catch (e) {
      setIsTTY(false)
    }

    return () => {
      try {
        ;(process.stdin as any).setRawMode?.(false)
        process.stdin.removeListener('data', handleData)
      } catch (e) {}
    }
  }, [isTTY, disabled, onSubmit])

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
        <StaticCursor />
      </Box>
      <Text dimColor>Press Enter to send, Ctrl+C to exit</Text>
    </Box>
  )
}
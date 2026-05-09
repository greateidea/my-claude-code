import React, { useState, useEffect, useRef, useReducer } from 'react'
import { Box, Text } from 'ink'

interface PromptInputProps {
  onSubmit: (text: string) => void
  disabled?: boolean
  onToggleThinking?: () => void
}

export interface InputState {
  text: string
  cursor: number
}

export type InputAction =
  | { type: 'insert'; char: string }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'move_left' }
  | { type: 'move_right' }
  | { type: 'move_home' }
  | { type: 'move_end' }
  | { type: 'word_left' }
  | { type: 'word_right' }
  | { type: 'kill_to_end' }
  | { type: 'kill_to_start' }
  | { type: 'clear' }

export function inputReducer(state: InputState, action: InputAction): InputState {
  const { text, cursor } = state

  switch (action.type) {
    case 'insert':
      return {
        text: text.slice(0, cursor) + action.char + text.slice(cursor),
        cursor: cursor + action.char.length,
      }

    case 'backspace':
      if (cursor > 0) {
        return {
          text: text.slice(0, cursor - 1) + text.slice(cursor),
          cursor: cursor - 1,
        }
      }
      return state

    case 'delete':
      if (cursor < text.length) {
        return {
          text: text.slice(0, cursor) + text.slice(cursor + 1),
          cursor,
        }
      }
      return state

    case 'move_left':
      return { ...state, cursor: Math.max(0, cursor - 1) }

    case 'move_right':
      return { ...state, cursor: Math.min(text.length, cursor + 1) }

    case 'move_home':
      return { ...state, cursor: 0 }

    case 'move_end':
      return { ...state, cursor: text.length }

    case 'word_left': {
      let p = cursor
      while (p > 0 && text[p - 1] === ' ') p--
      while (p > 0 && text[p - 1] !== ' ') p--
      return { ...state, cursor: p }
    }

    case 'word_right': {
      let p = cursor
      while (p < text.length && text[p] !== ' ') p++
      while (p < text.length && text[p] === ' ') p++
      return { ...state, cursor: p }
    }

    case 'kill_to_end':
      return { text: text.slice(0, cursor), cursor }

    case 'kill_to_start':
      return { text: text.slice(cursor), cursor: 0 }

    case 'clear':
      return { text: '', cursor: 0 }

    default:
      return state
  }
}

export function PromptInput({ onSubmit, disabled = false, onToggleThinking }: PromptInputProps) {
  const [state, dispatch] = useReducer(inputReducer, { text: '', cursor: 0 })
  const [isTTY, setIsTTY] = useState(false)
  const stateRef = useRef(state)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    setIsTTY(process.stdin.isTTY === true)
  }, [])

  useEffect(() => {
    if (!isTTY || disabled) return

    const handleData = (chunk: Buffer) => {
      const char = chunk.toString()
      const current = stateRef.current

      // Enter — submit
      if (char === '\r' || char === '\n') {
        if (current.text.trim()) {
          onSubmit(current.text)
          dispatch({ type: 'clear' })
        }
        return
      }

      // Ctrl+C — exit on empty, clear otherwise
      if (char === '\x03') {
        if (!current.text.trim()) {
          process.exit(0)
        }
        dispatch({ type: 'clear' })
        return
      }

      // 'T' on empty input — toggle thinking
      if (char === 'T' && !current.text.trim()) {
        onToggleThinking?.()
        return
      }

      // Ctrl+A — move to start of line
      if (char === '\x01') { dispatch({ type: 'move_home' }); return }

      // Ctrl+E — move to end of line
      if (char === '\x05') { dispatch({ type: 'move_end' }); return }

      // Ctrl+K — kill to end of line
      if (char === '\x0b') { dispatch({ type: 'kill_to_end' }); return }

      // Ctrl+U — kill to start of line
      if (char === '\x15') { dispatch({ type: 'kill_to_start' }); return }

      // Backspace
      if (char === '\x7f' || char === '\x08') { dispatch({ type: 'backspace' }); return }

      // Delete
      if (char === '\x1b[3~') { dispatch({ type: 'delete' }); return }

      // Left arrow
      if (char === '\x1b[D') { dispatch({ type: 'move_left' }); return }

      // Right arrow
      if (char === '\x1b[C') { dispatch({ type: 'move_right' }); return }

      // Home key
      if (char === '\x1b[H' || char === '\x1b[1~' || char === '\x1bOH') {
        dispatch({ type: 'move_home' }); return
      }

      // End key
      if (char === '\x1b[F' || char === '\x1b[4~' || char === '\x1bOF') {
        dispatch({ type: 'move_end' }); return
      }

      // Option+Left — word left
      if (char === '\x1b[1;2D' || char === '\x1bb') { dispatch({ type: 'word_left' }); return }

      // Option+Right — word right
      if (char === '\x1b[1;2C' || char === '\x1bf') { dispatch({ type: 'word_right' }); return }

      // Filter other escape sequences
      if (char.startsWith('\x1b')) return

      // Printable character — insert at cursor
      if (char.length > 0) {
        dispatch({ type: 'insert', char })
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
  }, [isTTY, disabled, onSubmit, onToggleThinking])

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

  const { text, cursor } = state
  const chars = [...text]

  // Build render segments: prefix + characters with cursor-highlighted char
  const segments: Array<{ text: string; inverse?: boolean; bold?: boolean; color?: string }> = [
    { text: '> ', bold: true, color: 'cyan' },
  ]

  for (let i = 0; i < chars.length; i++) {
    if (i === cursor) {
      segments.push({ text: chars[i]!, inverse: true })
    } else {
      segments.push({ text: chars[i]! })
    }
  }

  // Cursor at end of text — show a blinking-like inverse space
  if (cursor >= chars.length) {
    segments.push({ text: ' ', inverse: true })
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="dim">──</Text>
      </Box>

      {text.length === 0 ? (
        <Box>
          <Text bold color="cyan">{'>'} </Text>
          <Text bold inverse> </Text>
          <Text dimColor> (type your message)</Text>
        </Box>
      ) : (
        <Box>
          <Text wrap="wrap">
            {segments.map((seg, i) => (
              <Text key={i} inverse={seg.inverse} bold={seg.bold} color={seg.color}>
                {seg.text}
              </Text>
            ))}
          </Text>
        </Box>
      )}

      <Box>
        <Text dimColor>
          Enter: send  |  ←→: move  |  ^A/^E: home/end  |  ^C: exit
        </Text>
      </Box>
    </Box>
  )
}

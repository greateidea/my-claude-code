import React, { useState, useReducer } from 'react'
import { Box, Text, useInput } from '../ink'
import { inputReducer, type InputState } from './PromptInput'

interface PlanApprovalDialogProps {
  plan: string
  onApprove: (feedback?: string) => void
  onReject: (feedback: string) => void
}

/** Render feedback input text with cursor highlighting, same style as PromptInput. */
function renderFeedbackInput(state: InputState): React.ReactNode[] {
  const { text, cursor } = state
  const chars = [...text]
  const segments: React.ReactNode[] = []

  for (let i = 0; i < chars.length; i++) {
    if (i === cursor) {
      segments.push(<Text key={i} inverse>{chars[i]}</Text>)
    } else {
      segments.push(<Text key={i}>{chars[i]}</Text>)
    }
  }

  // Cursor at end — show inverse space as blinking cursor indicator
  if (cursor >= chars.length) {
    segments.push(<Text key="cursor" inverse> </Text>)
  }

  return segments
}

export const PlanApprovalDialog: React.FC<PlanApprovalDialogProps> = ({
  plan,
  onApprove,
  onReject,
}) => {
  const [selected, setSelected] = useState(0)
  const [feedbackState, dispatch] = useReducer(inputReducer, { text: '', cursor: 0 })
  const [inputMode, setInputMode] = useState(false)

  const options = [
    { label: 'Yes, proceed with implementation', value: 'approve' as const },
    { label: 'No, tell Claude what to change', value: 'reject' as const },
  ]

  useInput((_input, key) => {
    if (inputMode) {
      if (key.return) {
        const text = feedbackState.text
        if (selected === 0) {
          onApprove(text || undefined)
        } else {
          onReject(text || 'Revise the plan')
        }
        return
      }
      if (key.escape) {
        setInputMode(false)
        dispatch({ type: 'clear' })
        return
      }

      // Backspace
      if (_input === '\x7f' || _input === '\x08') { dispatch({ type: 'backspace' }); return }

      // Delete
      if (_input === '\x1b[3~') { dispatch({ type: 'delete' }); return }

      // Left arrow
      if (_input === '\x1b[D') { dispatch({ type: 'move_left' }); return }

      // Right arrow
      if (_input === '\x1b[C') { dispatch({ type: 'move_right' }); return }

      // Home
      if (_input === '\x1b[H' || _input === '\x1b[1~' || _input === '\x1bOH') {
        dispatch({ type: 'move_home' }); return
      }

      // End
      if (_input === '\x1b[F' || _input === '\x1b[4~' || _input === '\x1bOF') {
        dispatch({ type: 'move_end' }); return
      }

      // Option+Left — word left
      if (_input === '\x1b[1;2D' || _input === '\x1bb') { dispatch({ type: 'word_left' }); return }

      // Option+Right — word right
      if (_input === '\x1b[1;2C' || _input === '\x1bf') { dispatch({ type: 'word_right' }); return }

      // Ctrl+A — move to start
      if (_input === '\x01') { dispatch({ type: 'move_home' }); return }

      // Ctrl+E — move to end
      if (_input === '\x05') { dispatch({ type: 'move_end' }); return }

      // Ctrl+K — kill to end
      if (_input === '\x0b') { dispatch({ type: 'kill_to_end' }); return }

      // Ctrl+U — kill to start
      if (_input === '\x15') { dispatch({ type: 'kill_to_start' }); return }

      // Filter other escape sequences
      if (_input && _input.startsWith('\x1b')) return

      // Printable character
      if (_input && _input.length > 0) {
        dispatch({ type: 'insert', char: _input })
      }
      return
    }

    if (key.upArrow) {
      setSelected(s => Math.max(0, s - 1))
      return
    }
    if (key.downArrow) {
      setSelected(s => Math.min(options.length - 1, s + 1))
      return
    }
    if (key.return) {
      const option = options[selected]
      if (option.value === 'reject') {
        setInputMode(true)
      } else {
        onApprove()
      }
      return
    }
    if (key.escape) {
      onReject('')
      return
    }
  })

  // Truncate plan for display (show first 60 lines)
  const lines = plan.split('\n')
  const displayLines = lines.slice(0, 60)
  const truncated = lines.length > 60

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1} marginTop={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">Plan Approval</Text>
        <Text dimColor>Claude has written a plan and is ready to implement it.</Text>
      </Box>

      <Box flexDirection="column" borderStyle="classic" borderColor="gray" padding={1} marginBottom={1}>
        {displayLines.map((line, i) => (
          <Text key={i} dimColor>{line}</Text>
        ))}
        {truncated && <Text dimColor>... (truncated — full plan has {lines.length} lines)</Text>}
      </Box>

      {inputMode ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>Tell Claude what to change:</Text>
          <Box>
            <Text color="yellow">▸ </Text>
            <Text wrap="wrap">
              {renderFeedbackInput(feedbackState)}
            </Text>
          </Box>
          <Text dimColor>[←→] Move  [^A/^E] Home/End  [Enter] Submit  [Esc] Cancel</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {options.map((opt, i) => (
            <Box key={opt.value}>
              <Text color={selected === i ? 'cyan' : undefined}>
                {selected === i ? '▶' : ' '} {opt.label}
              </Text>
            </Box>
          ))}
          <Box marginTop={1}>
            <Text dimColor>[↑↓] Select [Enter] Confirm [Esc] Cancel</Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}

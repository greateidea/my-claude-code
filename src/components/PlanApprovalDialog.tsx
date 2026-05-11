import React, { useState, useReducer } from 'react'
import { Box, Text, useInput } from '../ink'
import { inputReducer, type InputState } from './PromptInput'

interface PlanApprovalDialogProps {
  plan: string
  onApprove: (feedback?: string) => void
  /** Clear context + auto mode — clears conversation and auto-sends implementation message */
  onClearContextAndAuto?: (feedback?: string) => void
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
  onClearContextAndAuto,
  onReject,
}) => {
  const [selected, setSelected] = useState(0)
  const [feedbackState, dispatch] = useReducer(inputReducer, { text: '', cursor: 0 })
  const [inputMode, setInputMode] = useState(false)

  const options = [
    { label: 'Yes, proceed with implementation', value: 'approve' as const },
    { label: 'Yes, clear context and auto mode', value: 'clearContext' as const },
    { label: 'No, tell MyClaude what to change', value: 'reject' as const },
  ]

  useInput((_input, key) => {
    if (inputMode) {
      if (key.return) {
        const text = feedbackState.text
        if (selected === 0) {
          onApprove(text || undefined)
        } else if (selected === 1) {
          onClearContextAndAuto?.(text || undefined)
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

      // Ink 7 delivers parsed key events — use key.* properties, not raw escape sequences.
      // For most special keys, _input is '' in Ink 7.

      if (key.backspace) { dispatch({ type: 'backspace' }); return }
      if (key.delete) { dispatch({ type: 'delete' }); return }
      if (key.leftArrow) {
        dispatch({ type: key.meta ? 'word_left' : 'move_left' }); return
      }
      if (key.rightArrow) {
        dispatch({ type: key.meta ? 'word_right' : 'move_right' }); return
      }
      if (key.home) { dispatch({ type: 'move_home' }); return }
      if (key.end) { dispatch({ type: 'move_end' }); return }

      // Option+Left/Right fallback — some terminals send raw escapes that Ink
      // doesn't fully parse into key.meta + key.leftArrow.
      if (_input === '\x1b[1;2D' || _input === '\x1bb') { dispatch({ type: 'word_left' }); return }
      if (_input === '\x1b[1;2C' || _input === '\x1bf') { dispatch({ type: 'word_right' }); return }

      // Ctrl key combinations (Ink 7 passes the control character as _input)
      if (_input === '\x01') { dispatch({ type: 'move_home' }); return }   // Ctrl+A
      if (_input === '\x05') { dispatch({ type: 'move_end' }); return }    // Ctrl+E
      if (_input === '\x0b') { dispatch({ type: 'kill_to_end' }); return } // Ctrl+K
      if (_input === '\x15') { dispatch({ type: 'kill_to_start' }); return } // Ctrl+U

      // Filter other escape sequences (not printable)
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
      if (option.value === 'reject' || option.value === 'clearContext') {
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
          <Text dimColor>Tell MyClaude what to change:</Text>
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

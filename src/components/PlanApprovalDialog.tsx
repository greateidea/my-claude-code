import React, { useState } from 'react'
import { Box, Text, useInput } from '../ink'

interface PlanApprovalDialogProps {
  plan: string
  onApprove: (feedback?: string) => void
  onReject: (feedback: string) => void
}

export const PlanApprovalDialog: React.FC<PlanApprovalDialogProps> = ({
  plan,
  onApprove,
  onReject,
}) => {
  const [selected, setSelected] = useState(0)
  const [feedback, setFeedback] = useState('')
  const [inputMode, setInputMode] = useState(false)

  const options = [
    { label: 'Yes, proceed with implementation', value: 'approve' as const },
    { label: 'No, tell Claude what to change', value: 'reject' as const },
  ]

  useInput((_input, key) => {
    if (inputMode) {
      if (key.return) {
        if (selected === 0) {
          onApprove(feedback || undefined)
        } else {
          onReject(feedback || 'Revise the plan')
        }
        return
      }
      if (key.escape) {
        setInputMode(false)
        setFeedback('')
        return
      }
      // Character input for feedback
      if (_input && _input.length > 0 && !_input.startsWith('\x1b')) {
        setFeedback(prev => prev + _input)
      }
      // Backspace
      if (_input === '\x7f' || _input === '\x08') {
        setFeedback(prev => prev.slice(0, -1))
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
            <Text>{feedback}</Text>
            <Text inverse> </Text>
          </Box>
          <Text dimColor>[Enter] Submit feedback [Esc] Cancel</Text>
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

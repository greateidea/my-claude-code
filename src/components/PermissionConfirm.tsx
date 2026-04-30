import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { PermissionRequest, PermissionResponse } from '../services/permissions.js'

interface PermissionConfirmProps {
  request: PermissionRequest
  onResponse: (response: PermissionResponse) => void
}

export const PermissionConfirm: React.FC<PermissionConfirmProps> = ({ request, onResponse }) => {
  const [selected, setSelected] = useState(0)

  const options = [
    { label: 'Allow once', value: 'allow_once' as const },
    { label: 'Deny once', value: 'reject_once' as const },
  ]

  useInput((input, key) => {
    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1))
      return
    }
    if (key.downArrow) {
      setSelected((s) => Math.min(options.length - 1, s + 1))
      return
    }
    if (key.return) {
      const option = options[selected]
      onResponse({
        allowed: option.value === 'allow_once',
        option: option.value,
      })
      return
    }
    if (key.escape) {
      onResponse({ allowed: false, option: 'reject_once' })
      return
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="yellow">⚠ Permission Required</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text>{request.title}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>Details: {request.description}</Text>
      </Box>

      <Box flexDirection="column">
        {options.map((opt, i) => (
          <Box key={opt.value}>
            <Text>  {selected === i ? '▶' : '  '} {opt.label}</Text>
          </Box>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>[↑↓] Select [Enter] Confirm [Esc] Deny</Text>
      </Box>
    </Box>
  )
}

export function createPermissionRequest(
  toolName: string,
  toolInput: Record<string, any>,
): PermissionRequest {
  let title = toolName
  let description = ''

  switch (toolName) {
    case 'Bash':
      title = `Bash: ${toolInput.command}`
      description = `Command: ${toolInput.command}\nCWD: ${toolInput.cwd || process.cwd()}`
      break
    case 'Write':
      title = `Write: ${toolInput.filePath}`
      description = `File: ${toolInput.filePath}\nContent: ${(toolInput.content || '').substring(0, 100)}...`
      break
    case 'Edit':
      title = `Edit: ${toolInput.filePath}`
      description = `File: ${toolInput.filePath}\nOperation: ${toolInput.operation || 'modify'}`
      break
    case 'Read':
      title = `Read: ${toolInput.filePath}`
      description = `File: ${toolInput.filePath}`
      break
    default:
      description = JSON.stringify(toolInput, null, 2)
  }

  return { toolName, toolInput, title, description }
}
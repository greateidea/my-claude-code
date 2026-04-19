import React from 'react'
import { Box, Text, Spacer } from 'ink'
import { Messages } from '../messages/Messages'
import { PromptInput } from '../PromptInput'

interface REPLProps {
  messages: Array<{ id: string; type: string; content: string; timestamp: number }>
  isLoading?: boolean
  error?: string | null
  onSendMessage?: (text: string) => void
  ready?: boolean
}

export function REPL({ messages, isLoading = false, error, onSendMessage, ready = false }: REPLProps) {
  const handleSubmit = onSendMessage ?? (() => {})

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold color="cyan">My Claude Code</Text>
        <Text color="cyan"> v0.1.0</Text>
        {ready ? (
          <Text color="green"> [OK]</Text>
        ) : (
          <Text color="red"> [NO API]</Text>
        )}
      </Box>

      <Spacer />

      <Messages messages={messages} />

      {isLoading && (
        <Box>
          <Text color="yellow">Thinking... </Text>
        </Box>
      )}

      {error && (
        <Box>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}

      <Spacer />

      <PromptInput onSubmit={handleSubmit} disabled={isLoading} />
    </Box>
  )
}
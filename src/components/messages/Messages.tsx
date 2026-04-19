import React from 'react'
import { Box, Text } from 'ink'

interface Message {
  id: string
  type: string
  content: string
  timestamp: number
}

interface MessagesProps {
  messages: Message[]
}

export function Messages({ messages }: MessagesProps) {
  if (messages.length === 0) {
    return (
      <Box>
        <Text color="gray">No messages. Start a conversation!</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {messages.map((m) => (
        <Box key={m.id} flexDirection="column">
          <Box>
            <Text bold color={m.type === 'user' ? 'green' : 'cyan'}>
              {m.type === 'user' ? '> ' : ''}
            </Text>
            <Text>{m.content}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}
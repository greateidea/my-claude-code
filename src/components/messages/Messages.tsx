import React from 'react'
import { Box, Text } from 'ink'

function cleanContent(content: string): string {
  return content
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool name="[^"]*">[\s\S]*?<\/tool>/g, '')
    .replace(/<param name="([^"]+)">([^<]+)<\/param>/g, '$2 ')
    .replace(/^\s+/gm, '')
    .replace(/^\s+$/gm, '')
    .trim()
}

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
  return (
    <Box flexDirection="column">
      {messages.length === 0 && (
        <Text color="gray">No messages. Start a conversation!</Text>
      )}
      {messages.map((m) => {
        let displayContent = m.type === 'assistant' || m.type === 'tool' ? cleanContent(m.content) : m.content
        if (!displayContent) displayContent = m.content // fallback
        if (!displayContent) return null
        const color = m.type === 'user' ? 'green' : m.type === 'tool' ? 'yellow' : 'cyan'
        return (
          <Box key={m.id} flexDirection="column">
            <Box>
              <Text bold color={color}>
                {m.type === 'user' ? '> ' : ''}
              </Text>
              <Text color={color}>{displayContent}</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}
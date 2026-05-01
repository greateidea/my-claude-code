import React from 'react'
import { Box, Text } from 'ink'
import { ThinkingMessage } from '../ThinkingMessage'

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
  thinking?: string
  timestamp: number
}

interface MessagesProps {
  messages: Message[]
  /** Only show thinking for the most recent assistant message */
  hidePastThinking?: boolean
  /** Controlled thinking expanded state (for keyboard toggle) */
  thinkingExpanded?: boolean
}

export function Messages({ messages, hidePastThinking, thinkingExpanded }: MessagesProps) {
  const lastAssistantId = hidePastThinking
    ? [...messages].reverse().find(m => m.type === 'assistant')?.id
    : undefined

  return (
    <Box flexDirection="column">
      {messages.length === 0 && (
        <Text color="gray">No messages. Start a conversation!</Text>
      )}
      {messages.map((m) => {
        let displayContent = m.type === 'assistant' || m.type === 'tool' ? cleanContent(m.content) : m.content
        if (!displayContent) displayContent = m.content // fallback
        if (!displayContent && !m.thinking) return null
        const color = m.type === 'user' ? 'green' : m.type === 'tool' ? 'yellow' : 'cyan'
        // hidePastThinking: only render thinking for the most recent assistant message
        const showThinking = m.type === 'assistant' && m.thinking && (!hidePastThinking || m.id === lastAssistantId)
        return (
          <Box key={m.id} flexDirection="column">
            {/* Render thinking block above assistant content */}
            {showThinking && (
              <ThinkingMessage thinking={m.thinking!} expanded={thinkingExpanded} />
            )}
            {displayContent ? (
              <Box>
                <Text bold color={color}>
                  {m.type === 'user' ? '> ' : ''}
                </Text>
                <Text color={color}>{displayContent}</Text>
              </Box>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}
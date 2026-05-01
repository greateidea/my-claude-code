import React from 'react'
import { Box, Text, Spacer } from 'ink'
import { Messages } from '../messages/Messages'
import { PromptInput } from '../PromptInput'
import { SpinnerGlyph } from '../SpinnerGlyph'
import { ShimmerText } from '../ShimmerText'

function cleanContent(content: string): string {
  return content
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool name="[^"]*">[\s\S]*?<\/tool>/g, '')
    .replace(/<param name="([^"]+)">([^<]+)<\/param>/g, '$2 ')
    .replace(/^\s+/gm, '')
    .replace(/^\s+$/gm, '')
    .trim()
}

interface REPLProps {
  messages: Array<{ id: string; type: string; content: string; thinking?: string; timestamp: number }>
  streamingContent?: string
  /** In-progress thinking from streaming — cleared when message is saved */
  thinkingContent?: string
  currentTool?: string | null
  isLoading?: boolean
  error?: string | null
  onSendMessage?: (text: string) => void
  ready?: boolean
  /** Controlled thinking expansion (for keyboard T toggle) */
  thinkingExpanded?: boolean
  onToggleThinking?: () => void
}

export function REPL({
  messages,
  streamingContent = '',
  thinkingContent = '',
  currentTool = null,
  isLoading = false,
  error,
  onSendMessage,
  ready = false,
  thinkingExpanded,
  onToggleThinking,
}: REPLProps) {
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

      <Messages messages={messages} hidePastThinking thinkingExpanded={thinkingExpanded} />

      {thinkingContent && (
        <Box flexDirection="column" marginLeft={2}>
          <Box>
            <SpinnerGlyph color="yellow" interval={120} />
            <Text> </Text>
            <Text color="dim" dimColor>Thinking:</Text>
          </Box>
          {thinkingContent.split('\n').map((line, i) => (
            <Text key={i} color="dim" dimColor>{line}</Text>
          ))}
        </Box>
      )}

      {currentTool && (
        <Box>
          <SpinnerGlyph color="yellow" interval={120} />
          <Text> </Text>
          <Text color="yellow">Tool: {currentTool}</Text>
        </Box>
      )}

      {streamingContent && (
        <Box>
          <Text color="cyan">{cleanContent(streamingContent)}</Text>
        </Box>
      )}

      {isLoading && !thinkingContent && !currentTool && (
        <Box>
          <SpinnerGlyph color="yellow" interval={120} />
          <Text> </Text>
          <ShimmerText text="Thinking..." color="yellow" />
        </Box>
      )}

      {error && (
        <Box>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}

      <Spacer />

      <PromptInput onSubmit={handleSubmit} disabled={isLoading} onToggleThinking={onToggleThinking} />
    </Box>
  )
}
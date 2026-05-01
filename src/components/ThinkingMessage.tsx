import React, { useState } from 'react'
import { Box, Text } from 'ink'

interface ThinkingMessageProps {
  thinking: string
  /** Show expanded by default; collapsed shows a one-line hint */
  defaultExpanded?: boolean
  /** When provided, the component is controlled (for keyboard toggle) */
  expanded?: boolean
  onToggle?: () => void
}

/**
 * Dedicated thinking display component — aligned with Claude Code's
 * AssistantThinkingMessage.
 *
 * Modes (simplified from Claude Code's 3-mode system):
 * - Expanded: full thinking content, dimmed style, "∴ Thinking:" label
 * - Collapsed (default): compact hint "∴ Thinking (T to expand)"
 */
export function ThinkingMessage({ thinking, defaultExpanded = false, expanded: controlledExpanded, onToggle }: ThinkingMessageProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded)
  const expanded = controlledExpanded !== undefined ? controlledExpanded : internalExpanded

  if (!thinking.trim()) return null

  return (
    <Box flexDirection="column" marginLeft={2}>
      {expanded ? (
        <>
          <Text color="dim" dimColor>
            ∴ Thinking:
          </Text>
          {thinking.split('\n').map((line, i) => (
            <Text key={i} color="dim" dimColor>
              {line}
            </Text>
          ))}
        </>
      ) : (
        <Text color="dim" dimColor>
          ∴ Thinking (T to expand)
        </Text>
      )}
    </Box>
  )
}

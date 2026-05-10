import React from 'react'
import { Text } from 'ink'
import { useAnimationFrame } from '../hooks/useAnimation'

interface ShimmerTextProps {
  text: string
  color?: string
  /** Characters to highlight at once */
  width?: number
  /** ms per sweep step */
  speed?: number
  /** When false, freezes the shimmer (stops animation ticks) */
  active?: boolean
}

/**
 * Renders text with a "shimmer sweep" — a highlight band that sweeps
 * across the text character by character, cycling around.
 *
 * Simplified from Claude Code's GlimmerMessage which uses a 3-char-wide
 * sweep across the verb text.
 *
 * Color scheme: highlighted chars get bold amber, others get dim yellow —
 * avoids the harsh pure-white inverse that clashes with TUI aesthetics.
 */
export function ShimmerText({ text, color = 'yellow', width = 3, speed = 80, active = true }: ShimmerTextProps) {
  const frame = useAnimationFrame(speed, active)

  return (
    <Text>
      {[...text].map((ch, i) => {
        // Sweep position cycles around the text length
        const pos = frame % text.length
        const dist = Math.min(
          Math.abs(i - pos),
          Math.abs(i - pos - text.length),
          Math.abs(i - pos + text.length),
        )
        const highlighted = dist < width
        return (
          <Text
            key={i}
            bold={highlighted}
            color={highlighted ? color : undefined}
            dimColor={!highlighted}
          >
            {ch}
          </Text>
        )
      })}
    </Text>
  )
}

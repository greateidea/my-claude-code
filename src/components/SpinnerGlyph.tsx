import React from 'react'
import { Text } from 'ink'
import { useAnimationFrame } from '../hooks/useAnimation'

const GLYPHS = ['✶', '✷', '✸', '✹', '✺', '✻', '✼', '✽', '✾', '✿']

/** Bounce: forward through all glyphs, then reverse for smooth cycling */
function bounceGlyph(frame: number): string {
  const cycle = GLYPHS.length * 2 - 2 // forward + reverse, no double-end
  const idx = frame % cycle
  if (idx < GLYPHS.length) return GLYPHS[idx]
  return GLYPHS[cycle - idx]
}

interface SpinnerGlyphProps {
  color?: string
  /** ms between glyph changes, default 120 (matches Claude Code) */
  interval?: number
  /** When false, freezes the current glyph (stops animation ticks) */
  active?: boolean
}

export function SpinnerGlyph({ color = 'yellow', interval = 120, active = true }: SpinnerGlyphProps) {
  const frame = useAnimationFrame(interval, active)
  return <Text color={color}>{bounceGlyph(frame)}</Text>
}

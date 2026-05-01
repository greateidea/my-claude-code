import { useState, useEffect } from 'react'

/**
 * Advances a frame counter on a setInterval, auto-cleans up.
 * Simplified equivalent of Claude Code's ClockContext + useAnimationFrame.
 *
 * @param intervalMs — frame interval (default 120ms ≈ 8fps, same as Claude Code spinner)
 * @param active — when false, freezes the frame counter (used when offscreen/idle)
 */
export function useAnimationFrame(intervalMs = 120, active = true): number {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setFrame(f => f + 1), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, active])

  return frame
}

/**
 * Sine-wave pulse value 0..1..0 over `periodMs`.
 */
export function usePulse(periodMs = 2000): number {
  const frame = useAnimationFrame(50)
  // frame * 50ms = elapsed ms; 2π / periodMs * elapsed = phase
  const phase = (2 * Math.PI * (frame * 50)) / periodMs
  return (Math.sin(phase) + 1) / 2 // 0..1
}

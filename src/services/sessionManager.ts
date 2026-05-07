import { mkdir, writeFile, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import { getSessionsDir } from './paths.js'
import type { SessionKind } from '../types/session.js'

// ---- Types ----

export interface SessionPidInfo {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  kind: SessionKind
  entrypoint?: string
}

// ---- Process liveness check ----

/**
 * Check if a process with the given PID is currently running.
 * Uses signal 0 — a no-op signal that only checks existence/permissions.
 * Returns false for pid <= 1 (init/launchd are always running).
 *
 * Aligned with Claude Code's isProcessRunning in genericProcessUtils.ts.
 */
function isProcessRunning(pid: number): boolean {
  if (pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---- Public API ----

/**
 * Register this session in the PID-based process registry.
 *
 * Writes ~/.myclaude/sessions/<pid>.json with metadata so:
 * 1. `claude ps` can list running sessions
 * 2. Orphan detection can find crashed sessions
 * 3. Concurrent session warnings can be shown
 *
 * Skips registration if this is a sub-agent (agentId != null).
 * Registers a cleanup handler to delete the PID file on normal exit.
 *
 * Aligned with Claude Code's registerSession() in concurrentSessions.ts.
 */
export async function registerSession(
  sessionId: string,
  cwd: string,
  kind: SessionKind = 'interactive',
): Promise<void> {
  const dir = getSessionsDir()
  const pidFile = join(dir, `${process.pid}.json`)

  // Register cleanup — delete PID file on exit.
  //
  // 'exit' is the primary handler: it always fires regardless of how the
  // process terminates (including Ink's raw-mode Ctrl+C where SIGINT is
  // never generated and beforeExit is skipped by process.exit()).
  //
  // Handlers must be synchronous because the 'exit' event does not wait
  // for async I/O.
  const cleanupSync = () => {
    try {
      const { unlinkSync } = require('fs')
      unlinkSync(pidFile)
    } catch {
      // ENOENT is fine — file already deleted or never written
    }
  }

  process.on('exit', cleanupSync)
  // Fallbacks for exits where these events do fire
  process.on('beforeExit', () => { try { const { unlinkSync } = require('fs'); unlinkSync(pidFile) } catch {} })
  process.on('SIGTERM', () => { try { const { unlinkSync } = require('fs'); unlinkSync(pidFile) } catch {} })

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(
      pidFile,
      JSON.stringify({
        pid: process.pid,
        sessionId,
        cwd,
        startedAt: Date.now(),
        kind,
        entrypoint: process.env.MYCLAUDE_ENTRYPOINT || 'cli',
      }),
      { mode: 0o600 },
    )
  } catch {
    // Best-effort — persistence still works without the registry
  }
}

/**
 * Unregister this session from the PID registry.
 * Called on clean exit to remove the PID file.
 */
export async function unregisterSession(): Promise<void> {
  const pidFile = join(getSessionsDir(), `${process.pid}.json`)
  try {
    await unlink(pidFile)
  } catch {
    // ENOENT is fine
  }
}

/**
 * Synchronous version — for exit cleanup when the event loop is closing.
 */
export function unregisterSessionSync(): void {
  const { unlinkSync } = require('fs')
  const pidFile = join(getSessionsDir(), `${process.pid}.json`)
  try {
    unlinkSync(pidFile)
  } catch {
    // ENOENT is fine
  }
}

/**
 * List all live sessions from the PID registry.
 * Filters out dead processes (orphans) and cleans up their PID files.
 *
 * Aligned with Claude Code's countConcurrentSessions() in concurrentSessions.ts.
 */
export async function listLiveSessions(): Promise<SessionPidInfo[]> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  const sessions: SessionPidInfo[] = []

  for (const file of files) {
    // Strict filename guard: only <pid>.json
    if (!/^\d+\.json$/.test(file)) continue

    const pid = parseInt(file.slice(0, -5), 10)
    const filePath = join(dir, file)

    if (pid === process.pid) {
      // Our own session
      try {
        const data = JSON.parse(
          await (await import('fs/promises')).readFile(filePath, 'utf-8'),
        )
        sessions.push(data as SessionPidInfo)
      } catch {
        // Corrupt file — skip
      }
    } else if (isProcessRunning(pid)) {
      try {
        const data = JSON.parse(
          await (await import('fs/promises')).readFile(filePath, 'utf-8'),
        )
        sessions.push(data as SessionPidInfo)
      } catch {
        // Corrupt file — skip
      }
    } else {
      // Dead process — sweep the stale file
      void unlink(filePath).catch(() => {})
    }
  }

  return sessions
}

/**
 * Find orphaned (crashed) sessions by checking the PID registry for
 * processes that are no longer running.
 *
 * These are sessions that can be resumed with --continue/--resume.
 * Unlike listLiveSessions, this keeps the stale PID files so the
 * caller can use them for recovery.
 */
export async function findOrphanedSessions(): Promise<SessionPidInfo[]> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  const orphans: SessionPidInfo[] = []

  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)
    if (pid === process.pid) continue // not an orphan
    if (!isProcessRunning(pid)) {
      try {
        const filePath = join(dir, file)
        const data = JSON.parse(
          await (await import('fs/promises')).readFile(filePath, 'utf-8'),
        )
        orphans.push(data as SessionPidInfo)
      } catch {
        // Corrupt file — sweep it
        void unlink(join(dir, file)).catch(() => {})
      }
    }
  }

  return orphans
}

/**
 * Check if another session is running in the same project directory.
 * Used for concurrent session warnings.
 */
export async function isAnotherSessionRunning(cwd: string): Promise<boolean> {
  const sessions = await listLiveSessions()
  return sessions.some(
    s => s.pid !== process.pid && s.cwd === cwd,
  )
}

import { readdir, readFile, appendFile, mkdir } from 'fs/promises'
import { createReadStream } from 'fs'
import { join, dirname } from 'path'
import { createInterface } from 'readline'
import type { UUID } from 'crypto'
import { getProjectDir, getTranscriptPath } from './paths.js'

// ---- Types ----

export interface TranscriptEntry {
  type: 'user' | 'assistant' | 'tool_result' | 'system'
  message: {
    role: string
    content: string
    /** Native tool_calls from the API response — stored on assistant entries */
    tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
    /** tool_call_id linking a tool_result back to the assistant's tool_calls entry */
    tool_call_id?: string
    /** reasoning_content from thinking-mode models — must be passed back in subsequent turns */
    reasoning_content?: string
  }
  uuid: string
  parentUuid: string | null
  timestamp: string
  sessionId: string
  /** Tool result metadata — present when type === 'tool_result' */
  toolUseResult?: {
    toolName?: string
    stdout?: string
    stderr?: string
    interrupted?: boolean
    /** Native API tool_call_id for proper tool role round-trip */
    toolCallId?: string
  }
  /** Links tool_result back to the assistant message that triggered the tool call */
  sourceToolAssistantUUID?: string
}

export interface SessionSummary {
  sessionId: string
  startedAt: string
  lastTimestamp: string
  messageCount: number
  filePath: string
}

export interface SessionMetadata {
  customTitle?: string
  tag?: string
  agentName?: string
  lastPrompt?: string
}

// ---- Internal helpers ----

/** Minimum bytes to read from the tail of a file for metadata extraction. */
const TAIL_WINDOW_BYTES = 64 * 1024

/**
 * Read the last ~64KB of a file. Used to extract session metadata without
 * reading the entire transcript. Aligned with Claude Code's readLiteMetadata pattern.
 */
async function readFileTail(filePath: string): Promise<string> {
  const { stat } = await import('fs/promises')
  const { open } = await import('fs/promises')
  const size = (await stat(filePath)).size
  const readSize = Math.min(size, TAIL_WINDOW_BYTES)
  const fd = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(readSize)
    await fd.read(buf, 0, readSize, size - readSize)
    return buf.toString('utf-8')
  } finally {
    await fd.close()
  }
}

/**
 * Load the set of UUIDs already present in a session file.
 * Used for deduplication — entries that already exist are skipped.
 */
async function loadExistingUuids(filePath: string): Promise<Set<string>> {
  const uuids = new Set<string>()
  try {
    const rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as { uuid?: string }
        if (entry.uuid) uuids.add(entry.uuid)
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File doesn't exist yet — empty set
  }
  return uuids
}

// ---- Public API ----

/**
 * Append a transcript entry to the session's JSONL file.
 *
 * Before writing, checks whether the entry UUID already exists in the file
 * (deduplication). If it does, the write is silently skipped.
 *
 * The file and parent directories are created automatically if needed.
 * Mode 0o600 for privacy.
 */
export async function appendEntry(
  cwd: string,
  sessionId: string,
  entry: TranscriptEntry | Record<string, unknown>,
): Promise<void> {
  const filePath = getTranscriptPath(cwd, sessionId)
  const entryWithUuid = entry as { uuid?: string }

  // Ensure directory exists
  try {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  } catch {
    // Directory already exists — fine
  }

  // Dedup: skip if this UUID is already in the file
  if (entryWithUuid.uuid) {
    const existing = await loadExistingUuids(filePath)
    if (existing.has(entryWithUuid.uuid)) return
  }

  const line = JSON.stringify(entry) + '\n'
  try {
    await appendFile(filePath, line, { mode: 0o600 })
  } catch {
    // File might not exist yet (race), try mkdir + append
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    await appendFile(filePath, line, { mode: 0o600 })
  }
}

/**
 * Synchronous version of appendEntry — used during exit cleanup when
 * the event loop may no longer schedule async I/O.
 *
 * Does NOT perform UUID dedup (the entry is guaranteed new at exit time).
 */
export function appendEntrySync(
  cwd: string,
  sessionId: string,
  entry: Record<string, unknown>,
): void {
  const { appendFileSync, mkdirSync } = require('fs')
  const filePath = getTranscriptPath(cwd, sessionId)
  const line = JSON.stringify(entry) + '\n'
  try {
    appendFileSync(filePath, line, { mode: 0o600 })
  } catch {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
    appendFileSync(filePath, line, { mode: 0o600 })
  }
}

/**
 * Load all transcript entries from a session JSONL file.
 * Returns entries in file order (which, for linear conversations, is the
 * correct conversation order).
 */
export async function loadConversation(
  cwd: string,
  sessionId: string,
): Promise<TranscriptEntry[]> {
  const filePath = getTranscriptPath(cwd, sessionId)
  const entries: TranscriptEntry[] = []

  try {
    const rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as TranscriptEntry
        entries.push(entry)
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File doesn't exist — return empty
  }

  return entries
}

/**
 * List all sessions for a project directory.
 * Scans the project dir for *.jsonl files and reads their first + last lines
 * to build summaries. Sorted by lastTimestamp descending (most recent first).
 */
export async function listSessions(cwd: string): Promise<SessionSummary[]> {
  const projectDir = getProjectDir(cwd)
  const summaries: SessionSummary[] = []

  let files: string[]
  try {
    files = await readdir(projectDir)
  } catch {
    return []
  }

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    const sessionId = file.slice(0, -6) // remove .jsonl suffix
    const filePath = join(projectDir, file)

    // Get tail for last timestamp
    let lastTimestamp = ''
    let messageCount = 0
    try {
      const tail = await readFileTail(filePath)
      const lines = tail.split('\n').filter(Boolean)
      messageCount = lines.length
      // Find last line with a timestamp
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i])
          if (entry.timestamp) {
            lastTimestamp = entry.timestamp
            break
          }
        } catch {
          continue
        }
      }
    } catch {
      continue
    }

    // Get first line for startedAt
    let startedAt = ''
    try {
      const rl = createInterface({
        input: createReadStream(filePath, { start: 0, end: 4096 }),
        crlfDelay: Infinity,
      })
      for await (const line of rl) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (entry.timestamp) {
            startedAt = entry.timestamp
            break
          }
        } catch {
          continue
        }
      }
    } catch {
      // Use lastTimestamp as fallback
      startedAt = lastTimestamp
    }

    summaries.push({
      sessionId,
      startedAt,
      lastTimestamp,
      messageCount,
      filePath,
    })
  }

  summaries.sort(
    (a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime(),
  )
  return summaries
}

/**
 * Get the most recent session for a project directory.
 * Returns null if no sessions exist.
 */
export async function getLastSession(cwd: string): Promise<SessionSummary | null> {
  const sessions = await listSessions(cwd)
  return sessions[0] ?? null
}

/**
 * Read session metadata from the tail of the JSONL file.
 *
 * Session metadata (title, tag, agent name) is written as special entries
 * at the end of the JSONL. This function reads the last 64KB and extracts
 * the most recent metadata entry.
 */
export async function readSessionMetadata(
  cwd: string,
  sessionId: string,
): Promise<SessionMetadata | null> {
  const filePath = getTranscriptPath(cwd, sessionId)
  let tail: string
  try {
    tail = await readFileTail(filePath)
  } catch {
    return null
  }

  const lines = tail.split('\n').filter(Boolean)
  // Scan backward for the most recent metadata entry
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i])
      if (entry.type === 'session_metadata') {
        return {
          customTitle: entry.customTitle as string | undefined,
          tag: entry.tag as string | undefined,
          agentName: entry.agentName as string | undefined,
          lastPrompt: entry.lastPrompt as string | undefined,
        }
      }
    } catch {
      continue
    }
  }

  return null
}

/**
 * Append session metadata to the JSONL file. Called on exit so the
 * next resume can quickly extract title/tag/agent from the tail.
 *
 * This mirrors Claude Code's reAppendSessionMetadata pattern:
 * metadata goes at the end so readSessionMetadata only needs to read
 * the last 64KB of the file.
 */
export async function appendSessionMetadata(
  cwd: string,
  sessionId: string,
  metadata: SessionMetadata,
): Promise<void> {
  const entry = {
    type: 'session_metadata' as const,
    uuid: `metadata-${Date.now()}`,
    parentUuid: null,
    timestamp: new Date().toISOString(),
    sessionId,
    message: { role: 'system' as const, content: '' },
    ...metadata,
  }
  await appendEntry(cwd, sessionId, entry)
}

/**
 * Synchronous version for exit cleanup.
 */
export function appendSessionMetadataSync(
  cwd: string,
  sessionId: string,
  metadata: SessionMetadata,
): void {
  const entry = {
    type: 'session_metadata',
    uuid: `metadata-${Date.now()}`,
    parentUuid: null,
    timestamp: new Date().toISOString(),
    sessionId,
    message: { role: 'system', content: '' },
    ...metadata,
  }
  appendEntrySync(cwd, sessionId, entry)
}

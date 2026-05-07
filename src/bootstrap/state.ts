import { randomUUID } from 'crypto'
import { cwd } from 'process'

let _sessionId: string = ''
let _projectRoot: string = ''
let _originalCwd: string = ''

/**
 * Initialize the session state. Must be called once at startup.
 *
 * If resumeSessionId is provided, the session is resumed — the existing
 * session UUID is reused so new messages append to the same JSONL file.
 * Otherwise a fresh UUID is generated.
 */
export function initializeSession(opts?: { resumeSessionId?: string }): void {
  _sessionId = opts?.resumeSessionId ?? randomUUID()
  _originalCwd = cwd()
  _projectRoot = findProjectRoot(_originalCwd)
}

/**
 * Switch the current session ID. Used during --resume to adopt the
 * restored session's UUID so future writes go to the correct JSONL.
 */
export function switchSession(sessionId: string): void {
  _sessionId = sessionId
}

export function getSessionId(): string {
  return _sessionId
}

export function getProjectRoot(): string {
  return _projectRoot
}

export function getOriginalCwd(): string {
  return _originalCwd
}

export function getCwd(): string {
  return cwd()
}

function findProjectRoot(startPath: string): string {
  return startPath
}

export function updateLastInteractionTime(): void {
  // Placeholder for tracking user activity
}

export function getLastInteractionTime(): number {
  return Date.now()
}

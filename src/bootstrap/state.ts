import { randomUUID } from 'crypto'
import { cwd } from 'process'

let _sessionId: string = ''
let _projectRoot: string = ''
let _originalCwd: string = ''

export function initializeSession(): void {
  _sessionId = randomUUID()
  _originalCwd = cwd()
  _projectRoot = findProjectRoot(_originalCwd)
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
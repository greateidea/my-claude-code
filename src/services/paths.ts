import { homedir } from 'os'
import { join } from 'path'

/**
 * Sanitize a project path for use as a directory name.
 * Replaces / with - so "/Users/name/my-project" becomes "-Users-name-my-project".
 *
 * This is the same algorithm Claude Code uses in sessionStorage.ts:436-438.
 * We use sanitized paths instead of MD5 hashes for readability — you can
 * look at the directory structure and know which project it corresponds to.
 */
export function sanitizeProjectPath(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

/** Root directory for all my-claude-code data. */
export function getMyClaudeDir(): string {
  return join(homedir(), '.myclaude')
}

/** Directory where per-project session subdirectories live. */
export function getProjectsDir(): string {
  return join(getMyClaudeDir(), 'projects')
}

/** Directory for a specific project's data (transcripts, memory, etc.). */
export function getProjectDir(cwd: string): string {
  return join(getProjectsDir(), sanitizeProjectPath(cwd))
}

/** Directory where PID-based session registry files live. */
export function getSessionsDir(): string {
  return join(getMyClaudeDir(), 'sessions')
}

/** Path to the JSONL transcript file for a given session. */
export function getTranscriptPath(cwd: string, sessionId: string): string {
  return join(getProjectDir(cwd), `${sessionId}.jsonl`)
}

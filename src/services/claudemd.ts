import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface LoadedClaudeMdFile {
  path: string
  content: string
  type: 'Project' | 'Local'
}

/**
 * Discover and load CLAUDE.md files for the given project directory.
 *
 * Priority (later overrides earlier):
 * 1. {cwd}/CLAUDE.md        — project instructions, checked into git
 * 2. {cwd}/myclaude/CLAUDE.md — project instructions, checked into git
 * 3. {cwd}/CLAUDE.local.md  — user's private project instructions, not checked in
 *
 * This is a simplified version of Claude Code's full chain (which also includes
 * Managed/User levels and upward directory traversal).
 */
export async function loadClaudeMdFiles(cwd: string): Promise<LoadedClaudeMdFile[]> {
  const files: LoadedClaudeMdFile[] = []

  const candidates: { path: string; type: 'Project' | 'Local' }[] = [
    { path: join(cwd, 'CLAUDE.md'), type: 'Project' },
    { path: join(cwd, 'myclaude', 'CLAUDE.md'), type: 'Project' },
    { path: join(cwd, 'CLAUDE.local.md'), type: 'Local' },
  ]

  for (const { path, type } of candidates) {
    if (existsSync(path)) {
      try {
        const content = await readFile(path, 'utf-8')
        files.push({ path, content, type })
      } catch {
        // Permission errors, etc. — skip silently
      }
    }
  }

  return files
}

const MEMORY_INSTRUCTION_PROMPT =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.'

/**
 * Format loaded CLAUDE.md files into the prompt text that gets injected
 * as user context (wrapped in <system-reminder> by the caller).
 */
export function formatClaudeMdPrompt(files: LoadedClaudeMdFile[]): string | null {
  if (files.length === 0) return null

  const memories: string[] = []

  for (const file of files) {
    const description =
      file.type === 'Project'
        ? ' (project instructions, checked into the codebase)'
        : " (user's private project instructions, not checked in)"

    memories.push(`Contents of ${file.path}${description}:\n\n${file.content}`)
  }

  return `${MEMORY_INSTRUCTION_PROMPT}\n\n${memories.join('\n\n')}`
}

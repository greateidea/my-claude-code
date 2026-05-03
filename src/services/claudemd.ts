import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface LoadedClaudeMdFile {
  path: string
  content: string
  type: 'Project' | 'Local'
}

/**
 * Find the git repository root for a given directory.
 * Returns the top-level path or null if not in a git repo.
 */
async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      timeout: 5000,
    })
    return stdout.trim()
  } catch {
    return null
  }
}

/**
 * Discover and load CLAUDE.md files for the given project directory.
 *
 * Walks upward from cwd to git root, collecting CLAUDE.md files at each level.
 * Files closer to cwd appear later in the array → higher priority in the prompt
 * (the LLM gives later instructions more weight).
 *
 * Discovery order (within each directory):
 * 1. {dir}/CLAUDE.md           — project instructions, checked into git
 * 2. {dir}/myclaude/CLAUDE.md  — project instructions, checked into git
 * 3. {dir}/CLAUDE.local.md     — user's private project instructions, not checked in
 *
 * Walk order (lower to higher priority):
 *   Git root → intermediate dirs → cwd
 *
 * This mirrors Claude Code's upward traversal — subdirectory CLAUDE.md files can
 * override parent directory instructions. For example, src/legacy/CLAUDE.md can
 * relax code style restrictions for legacy code.
 */
export async function loadClaudeMdFiles(cwd: string): Promise<LoadedClaudeMdFile[]> {
  const files: LoadedClaudeMdFile[] = []

  // Find git root as the upward traversal boundary (fall back to cwd only)
  const gitRoot = await getGitRoot(cwd)
  const root = gitRoot ?? cwd

  // Collect directories from cwd up to root, then reverse for root-first ordering
  const dirs: string[] = []
  let current = cwd
  while (true) {
    dirs.push(current)
    if (current === root || current === dirname(current)) break
    current = dirname(current)
  }
  dirs.reverse()

  const candidates: Array<{ filename: string; type: 'Project' | 'Local' }> = [
    { filename: 'CLAUDE.md', type: 'Project' },
    { filename: join('myclaude', 'CLAUDE.md'), type: 'Project' },
    { filename: 'CLAUDE.local.md', type: 'Local' },
  ]

  for (const dir of dirs) {
    for (const { filename, type } of candidates) {
      const path = join(dir, filename)
      if (existsSync(path)) {
        try {
          const content = await readFile(path, 'utf-8')
          files.push({ path, content, type })
        } catch {
          // Permission errors, etc. — skip silently
        }
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

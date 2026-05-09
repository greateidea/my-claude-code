import { z } from 'zod'
import { exec, execFile } from 'child_process'
import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises'
import { join, dirname } from 'path'
import { existsSync } from 'fs'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

async function safeExec(command: string, timeout = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Command timeout after ${timeout}ms`))
    }, timeout)

    exec(command, { timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      clearTimeout(timer)
      if (error) {
        reject(new Error(stderr || error.message))
      } else {
        resolve(stdout)
      }
    })
  })
}

export interface ToolInput {
  [key: string]: any
}

export interface Tool {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  execute: (input: ToolInput) => Promise<string>
  isConcurrencySafe?: (input: ToolInput) => boolean
}

function readOnlyTool(): Partial<Tool> {
  return {
    isConcurrencySafe: () => true,
  }
}

function writeTool(): Partial<Tool> {
  return {
    isConcurrencySafe: () => false,
  }
}

export const BashTool: Tool = {
  name: 'bash',
  description: 'Execute shell commands and return the output',
  inputSchema: {
    command: z.string().describe('Shell command to execute'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default: 30000)').refine(v => v === undefined || (v >= 300 && v <= 600000), 'Timeout must be between 300ms and 600000ms (10 min)'),
  },
  execute: async ({ command, timeout = 30000 }) => {
    try {
      const clamped = Math.min(Math.max(timeout, 300), 600000)
      const output = await safeExec(command, clamped)
      return output.slice(0, 100000)
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
  ...writeTool(),
}

export const FileReadTool: Tool = {
  name: 'Read',
  description: 'Read file contents',
  inputSchema: {
    file_path: z.string().describe('Path to file to read'),
  },
  execute: async ({ file_path }) => {
    try {
      if (!existsSync(file_path)) {
        return `Error: File not found: ${file_path}`
      }
      const content = await readFile(file_path, 'utf-8')
      return content.slice(0, 100000)
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
  ...readOnlyTool(),
}

export const FileWriteTool: Tool = {
  name: 'Write',
  description: 'Write content to a file (creates or overwrites)',
  inputSchema: {
    file_path: z.string().describe('Path to file to write'),
    content: z.string().describe('Content to write'),
  },
  execute: async ({ file_path, content }) => {
    try {
      const dir = dirname(file_path)
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true })
      }
      await writeFile(file_path, content, 'utf-8')
      return `Written to ${file_path}`
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
  ...writeTool(),
}

export const EditTool: Tool = {
  name: 'Edit',
  description: `Performs exact string replacements in files.

Usage:
- The edit will FAIL if old_string is not unique in the file.
  Either provide a larger string with more surrounding context to make it unique or use replace_all.
- Use replace_all for replacing and renaming strings across the file.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.`,
  inputSchema: {
    file_path: z.string().describe('The absolute path to the file to modify'),
    old_string: z.string().describe('The text to replace'),
    new_string: z.string().describe('The text to replace it with (must be different from old_string)'),
    replace_all: z.boolean().optional().describe('Replace all occurrences of old_string (default false)'),
  },
  execute: async ({ file_path, old_string, new_string, replace_all }) => {
    try {
      if (!file_path.startsWith('/')) {
        return `Error: file_path must be an absolute path, not a relative path. Got: ${file_path}`
      }
      if (!old_string) {
        return 'Error: old_string must not be empty'
      }
      if (old_string === new_string) {
        return 'Error: old_string and new_string must be different'
      }
      if (!existsSync(file_path)) {
        return `Error: File not found: ${file_path}`
      }

      const content = await readFile(file_path, 'utf-8')
      const count = content.split(old_string).length - 1

      if (count === 0) {
        return `Error: old_string not found in file. Make sure the string exactly matches (including whitespace).`
      }
      if (count > 1 && !replace_all) {
        return `Error: old_string appears ${count} times in file. Either set replace_all to true or add more surrounding context to make old_string unique.`
      }

      const newContent = replace_all
        ? content.replaceAll(old_string, new_string)
        : content.replace(old_string, new_string)

      await writeFile(file_path, newContent, 'utf-8')
      const replaced = replace_all ? count : 1
      return `Successfully replaced ${replaced} occurrence(s) in ${file_path}`
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
  ...writeTool(),
}

export const GlobTool: Tool = {
  name: 'Glob',
  description: 'Search for files matching a pattern',
  inputSchema: {
    pattern: z.string().describe('Glob pattern (e.g., "**/*.ts")'),
    path: z.string().optional().describe('Directory to search (default: current)'),
  },
  execute: async ({ pattern, path = '.' }) => {
    try {
      const results: string[] = []
      
      async function search(dir: string, pat: string) {
        try {
          const entries = await readdir(dir, { withFileTypes: true })
          for (const entry of entries) {
            const fullPath = join(dir, entry.name)
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
              await search(fullPath, pat)
            } else if (entry.name.match(pat.replace('*', '.*'))) {
              results.push(fullPath)
            }
          }
        } catch {}
      }
      
      await search(path, pattern)
      return results.slice(0, 100).join('\n') || 'No matches found'
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
  ...readOnlyTool(),
}

export const GrepTool: Tool = {
  name: 'Grep',
  description: `A powerful search tool built on ripgrep.

Usage:
- ALWAYS use Grep for search tasks. NEVER invoke grep or rg as a Bash command.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Filter files with glob parameter (e.g., "*.js", "**/*.tsx")
- Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
- Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)`,
  inputSchema: {
    pattern: z.string().describe('The regular expression pattern to search for in file contents'),
    path: z.string().optional().describe('File or directory to search in. Defaults to current working directory.'),
    glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")'),
    output_mode: z.string().optional().describe('Output mode: "content" shows matching lines, "files_with_matches" shows file paths (default), "count" shows match counts'),
    '-i': z.boolean().optional().describe('Case insensitive search (rg -i)'),
    head_limit: z.number().optional().describe('Limit output to first N entries (default 250). Set 0 for unlimited.'),
  },
  execute: async ({ pattern, path, glob, output_mode, '-i': caseInsensitive, head_limit = 250 }) => {
    const mode = output_mode || 'files_with_matches'
    const searchPath = path || '.'

    // Try ripgrep first (fast native binary)
    try {
      const args: string[] = ['--no-heading', '--with-filename']

      if (mode === 'files_with_matches') args.push('-l')
      if (mode === 'count') args.push('-c')
      if (mode === 'content') args.push('-n')
      if (caseInsensitive) args.push('-i')
      if (glob) args.push('--glob', glob)

      args.push('--', pattern, searchPath)

      const result = await execFileAsync('rg', args, {
        timeout: 10000,
        maxBuffer: 10 * 1024 * 1024,
      })

      let output = result.stdout.trim()
      if (head_limit > 0 && output) {
        output = output.split('\n').slice(0, head_limit).join('\n')
      }

      return output || 'No matches found'
    } catch (e: any) {
      if (e.code === 1) return 'No matches found' // rg exits 1 for no matches
      // rg exits 2 for errors; return stderr if available
      if (e.stderr) return `Error: ${e.stderr}`

      // Fallback: ripgrep not installed — use pure Node.js
      if (e.code !== 'ENOENT') return `Error: ${e.message}`
    }

    // ---- Node.js fallback ----
    try {
      const flag = caseInsensitive ? 'gi' : 'g'
      const regex = new RegExp(pattern, flag)

      // Glob → regex conversion (simple: *, **, ?)
      let fileFilter: RegExp | null = null
      if (glob) {
        const globRegex = glob
          .replace(/\./g, '\\.')
          .replace(/\*\*/g, '{{GLOBSTAR}}')
          .replace(/\*/g, '[^/]*')
          .replace(/\{\{GLOBSTAR\}\}/g, '.*')
          .replace(/\?/g, '.')
          .replace(/\{([^,]+)\}/g, (_: string, cs: string) => `(${cs.split(',').join('|')})`)
        fileFilter = new RegExp(globRegex)
      }

      // Walk directory recursively, skip common noise
      const skipDirs = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.venv', 'venv', '.cache'])
      const MAX_FILES = 1000
      const matches: Array<{ file: string; line?: number; text?: string }> = []
      const fileCounts = new Map<string, number>()

      async function walk(dir: string) {
        if (matches.length >= MAX_FILES) return
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch { return }
        for (const entry of entries) {
          if (matches.length >= MAX_FILES) return
          if (entry.name.startsWith('.') && entry.name !== '.') continue // skip dotfiles/dirs
          const full = join(dir, entry.name)
          if (entry.isDirectory()) {
            if (skipDirs.has(entry.name)) continue
            await walk(full)
          } else if (entry.isFile()) {
            if (fileFilter && !fileFilter.test(entry.name)) continue
            try {
              const content = await readFile(full, 'utf-8')
              const lines = content.split('\n')
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  matches.push({ file: full, line: i + 1, text: lines[i] })
                  fileCounts.set(full, (fileCounts.get(full) || 0) + 1)
                }
              }
              // Mark file as searched even if no line matched (for files_with_matches mode)
              if (mode === 'files_with_matches' && fileCounts.has(full)) {
                // already counted
              } else if (mode === 'count' && !fileCounts.has(full)) {
                fileCounts.set(full, 0)
              }
            } catch { /* skip unreadable files */ }
          }
        }
      }

      const stat_ = await stat(searchPath)
      if (stat_.isDirectory()) {
        await walk(searchPath)
      } else {
        // Single file
        try {
          const content = await readFile(searchPath, 'utf-8')
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matches.push({ file: searchPath, line: i + 1, text: lines[i] })
              fileCounts.set(searchPath, (fileCounts.get(searchPath) || 0) + 1)
            }
          }
        } catch { return `Error: Cannot read ${searchPath}` }
      }

      // Format output
      let lines: string[]
      switch (mode) {
        case 'files_with_matches':
          lines = [...new Set(matches.map(m => m.file))]
          break
        case 'count':
          lines = [...fileCounts.entries()]
            .filter(([, c]) => c > 0)
            .map(([f, c]) => `${f}: ${c}`)
          break
        case 'content':
        default:
          lines = matches.map(m => `${m.file}:${m.line}: ${m.text}`)
          // Dedup identical lines (same file+line)
          lines = [...new Set(lines)]
          break
      }

      if (head_limit > 0) lines = lines.slice(0, head_limit)
      return lines.length > 0 ? lines.join('\n') : 'No matches found'
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
  ...readOnlyTool(),
}

export const CalculateTool: Tool = {
  name: 'calculate',
  description: 'Evaluate math expressions',
  inputSchema: {
    expression: z.string().describe('Math expression to evaluate'),
  },
  execute: async ({ expression }) => {
    try {
      const result = Function(`"use strict"; return (${expression})`)()
      return String(result)
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
  ...readOnlyTool(),
}

// ========== Plan Mode Tools ==========

// These are placed after the main tool array because they reference plan utilities
// that import from our own services (lazy-loaded in execute to avoid circular deps).

export const EnterPlanModeTool: Tool = {
  name: 'EnterPlanMode',
  description: `Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment.

## When to Use This Tool

**Prefer using EnterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:

1. **New Feature Implementation**: Adding meaningful new functionality
2. **Multiple Valid Approaches**: The task can be solved in several different ways
3. **Code Modifications**: Changes that affect existing behavior or structure
4. **Architectural Decisions**: The task requires choosing between patterns or technologies
5. **Multi-File Changes**: The task will likely touch more than 2-3 files
6. **Unclear Requirements**: You need to explore before understanding the full scope
7. **User Preferences Matter**: The implementation could reasonably go multiple ways

## When NOT to Use This Tool

Only skip EnterPlanMode for simple tasks:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- Adding a single function with clear requirements
- Pure research/exploration tasks

## What Happens in Plan Mode

In plan mode, you can only read/search files and write to the plan file. You cannot modify code or run Bash commands. Explore the codebase, design an approach, write the plan, then call ExitPlanMode for user approval.`,
  inputSchema: {},
  execute: async () => {
    const { permissionManager } = await import('../services/permissions')
    const { createPlanFile } = await import('../services/plans')

    if (permissionManager.getMode() === 'plan') {
      return 'Already in plan mode.'
    }

    // Save current mode for restoration on exit
    const prePlanMode = permissionManager.getMode()
    ;(permissionManager as any)._prePlanMode = prePlanMode

    permissionManager.setMode('plan')
    const planPath = createPlanFile()

    return `Entered plan mode. Plan file: ${planPath}

Plan mode is now active. You are in a read-only research phase:
1. Explore the codebase using Read/Glob/Grep tools
2. Design your implementation approach
3. Write your plan to the plan file using the Write tool (this is the ONLY file you may modify)
4. When your plan is complete, call ExitPlanMode to present it for user approval

Do NOT make any edits outside the plan file. Do NOT run Bash commands.`
  },
  isConcurrencySafe: () => false,
}

export const ExitPlanModeTool: Tool = {
  name: 'ExitPlanMode',
  description: `Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.

## How This Tool Works
- You should have already written your plan to the plan file specified when you entered plan mode
- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote
- This tool simply signals that you're done planning and ready for the user to review and approve
- The user will see the contents of your plan file when they review it

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous. Once your plan is finalized, use THIS tool to request approval.

## Examples
1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.`,
  inputSchema: {},
  execute: async () => {
    const { permissionManager } = await import('../services/permissions')
    const { getPlan, getPlanApprovalHandler } = await import('../services/plans')

    if (permissionManager.getMode() !== 'plan') {
      return 'You are not in plan mode. This tool is only for exiting plan mode after writing a plan.'
    }

    const plan = getPlan()
    if (!plan || plan.trim() === '' || plan.trim() === '# Plan\n\n') {
      return 'No plan found. Please write your plan to the plan file before calling ExitPlanMode.'
    }

    // Request user approval
    const handler = getPlanApprovalHandler()
    if (!handler) {
      // No handler registered — exit plan mode directly
      permissionManager.setMode((permissionManager as any)._prePlanMode || 'default')
      return 'Exited plan mode (no approval handler registered).'
    }

    const result = await handler(plan)

    if (result.approved) {
      // Restore pre-plan mode
      const prePlanMode = (permissionManager as any)._prePlanMode || 'default'
      permissionManager.setMode(prePlanMode)
      delete (permissionManager as any)._prePlanMode

      const feedbackNote = result.feedback ? `\n\nUser feedback: ${result.feedback}` : ''
      return `User has approved your plan. You can now start coding.${feedbackNote}\n\n## Approved Plan:\n${plan}`
    } else {
      // User rejected — stay in plan mode
      const feedbackNote = result.feedback ? `\n\nUser feedback: ${result.feedback}` : ''
      return `User wants you to revise the plan.${feedbackNote}\n\nPlease update the plan file and call ExitPlanMode again when ready.`
    }
  },
  isConcurrencySafe: () => false,
}

export const AVAILABLE_TOOLS = [CalculateTool, BashTool, FileReadTool, EditTool, FileWriteTool, GlobTool, GrepTool, EnterPlanModeTool, ExitPlanModeTool]

export function findToolByName(tools: Tool[], name: string): Tool | undefined {
  return tools.find(t => t.name === name)
}
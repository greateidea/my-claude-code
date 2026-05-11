import { z } from 'zod'
import { execFile } from 'child_process'
import { readFile, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'util'
import { type Tool, readOnlyTool } from './types'

const execFileAsync = promisify(execFile)

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

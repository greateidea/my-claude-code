import { z } from 'zod'
import { readdir } from 'fs/promises'
import { join } from 'path'
import { type Tool, readOnlyTool } from './types'

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

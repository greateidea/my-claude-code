import { z } from 'zod'
import { exec } from 'child_process'
import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises'
import { join, dirname } from 'path'
import { existsSync } from 'fs'

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

export interface Tool {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  execute: (input: any) => Promise<string>
}

export const BashTool: Tool = {
  name: 'bash',
  description: 'Execute shell commands and return the output',
  inputSchema: {
    command: z.string().describe('Shell command to execute'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default: 30000)'),
  },
  execute: async ({ command, timeout = 30000 }) => {
    try {
      const output = await safeExec(command, timeout)
      return output.slice(0, 100000) // Limit output size
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
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
      // Limit to first 100KB
      return content.slice(0, 100000)
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
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
      // Ensure directory exists
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
      // Simple recursive search
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
}

export const AVAILABLE_TOOLS = [BashTool, FileReadTool, FileWriteTool, GlobTool]
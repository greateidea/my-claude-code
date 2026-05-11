import { z } from 'zod'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { type Tool, readOnlyTool } from './types'

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

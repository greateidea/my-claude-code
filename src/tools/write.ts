import { z } from 'zod'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { type Tool, writeTool } from './types'

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

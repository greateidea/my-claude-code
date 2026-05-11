import { z } from 'zod'
import { exec } from 'child_process'
import { type Tool, writeTool } from './types'

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

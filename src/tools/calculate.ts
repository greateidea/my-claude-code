import { z } from 'zod'
import { type Tool, readOnlyTool } from './types'

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

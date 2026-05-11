import { z } from 'zod'

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

export function readOnlyTool(): Partial<Tool> {
  return {
    isConcurrencySafe: () => true,
  }
}

export function writeTool(): Partial<Tool> {
  return {
    isConcurrencySafe: () => false,
  }
}

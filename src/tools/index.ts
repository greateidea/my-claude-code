// Types and helpers
export { type Tool, type ToolInput, readOnlyTool, writeTool } from './types'

// Tools
export { BashTool } from './bash'
export { FileReadTool } from './read'
export { FileWriteTool } from './write'
export { EditTool } from './edit'
export { GlobTool } from './glob'
export { GrepTool } from './grep'
export { CalculateTool } from './calculate'
export { EnterPlanModeTool } from './enterPlanMode'
export { ExitPlanModeTool } from './exitPlanMode'
export { WebSearchTool } from './websearch'
export { WebFetchTool } from './webfetch'

import { type Tool } from './types'
import { BashTool } from './bash'
import { FileReadTool } from './read'
import { FileWriteTool } from './write'
import { EditTool } from './edit'
import { GlobTool } from './glob'
import { GrepTool } from './grep'
import { CalculateTool } from './calculate'
import { EnterPlanModeTool } from './enterPlanMode'
import { ExitPlanModeTool } from './exitPlanMode'
import { WebSearchTool } from './websearch'
import { WebFetchTool } from './webfetch'

export const AVAILABLE_TOOLS = [
  CalculateTool,
  BashTool,
  FileReadTool,
  EditTool,
  FileWriteTool,
  GlobTool,
  GrepTool,
  EnterPlanModeTool,
  ExitPlanModeTool,
  WebSearchTool,
  WebFetchTool,
]

export function findToolByName(tools: Tool[], name: string): Tool | undefined {
  return tools.find(t => t.name === name)
}

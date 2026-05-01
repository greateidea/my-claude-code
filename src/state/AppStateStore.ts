import type { Store } from './store.js'

export interface Message {
  id: string
  type: 'user' | 'assistant' | 'system' | 'tool' | 'tool-result'
  content: string
  thinking?: string
  timestamp: number
}

export interface ToolPermission {
  name: string
  allowed: boolean
  lastDenied?: string
}

export interface AppState {
  messages: Message[]
  inputText: string
  isLoading: boolean
  error: string | null
  
  // Session info
  sessionId: string
  cwd: string
  model: string
  
  // Permissions
  toolPermissions: ToolPermission[]
  
  // UI state
  showSidebar: boolean
  selectedMessageId: string | null
}

export const DEFAULT_APP_STATE: AppState = {
  messages: [],
  inputText: '',
  isLoading: false,
  error: null,
  
  sessionId: '',
  cwd: process.cwd(),
  model: 'claude-3-5-sonnet-20241022',
  
  toolPermissions: [],
  
  showSidebar: false,
  selectedMessageId: null,
}

export type AppStateStore = Store<AppState>
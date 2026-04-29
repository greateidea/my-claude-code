export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions'

export type PermissionDecision = 'allow' | 'deny' | 'ask'

export interface PermissionRule {
  tool: string
  specifier: string | null
}

export interface PermissionCheckResult {
  decision: PermissionDecision
  rule?: string
  source?: 'allow' | 'deny' | 'ask' | 'readonly' | 'session' | 'acceptEdits'
}

export interface PermissionRequest {
  toolName: string
  toolInput: Record<string, any>
  title: string
  description: string
}

export interface PermissionResponse {
  allowed: boolean
  option: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
  rule?: string
}

interface PermissionRuleSet {
  allow: string[]
  deny: string[]
  ask: string[]
}

const DEFAULT_RULES: PermissionRuleSet = {
  allow: [],
  deny: [],
  ask: ['Bash', 'Write', 'Edit', 'WebFetch'],
}

const READONLY_TOOLS = new Set(['Read', 'Glob', 'Grep'])

const READONLY_BASH_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'diff', 'stat', 'du', 'cd',
  'pwd', 'file', 'which', 'whoami', 'git status', 'git log', 'git diff', 'git show',
])

export class PermissionManager {
  private mode: PermissionMode = 'default'
  private rules: PermissionRuleSet = DEFAULT_RULES
  private sessionAllowed: Set<string> = new Set()
  private sessionDenied: Set<string> = new Set()
  private onPermissionRequest: ((request: PermissionRequest) => Promise<PermissionResponse>) | null = null

  setMode(mode: PermissionMode) {
    this.mode = mode
  }

  getMode(): PermissionMode {
    return this.mode
  }

  setRules(rules: Partial<PermissionRuleSet>) {
    this.rules = { ...this.rules, ...rules }
  }

  getRules(): PermissionRuleSet {
    return this.rules
  }

  setPermissionHandler(handler: (request: PermissionRequest) => Promise<PermissionResponse>) {
    this.onPermissionRequest = handler
  }

  private parseRule(rule: string): PermissionRule {
    const match = rule.match(/^(\w+)\((.*)\)$/)
    if (match) {
      return { tool: match[1], specifier: match[2] }
    }
    return { tool: rule, specifier: null }
  }

  private matchTool(tool: string, toolName: string): boolean {
    if (tool === toolName) return true
    if (toolName.startsWith('mcp__')) {
      const parts = toolName.split('__')
      if (tool === parts[1]) return true
      if (tool === `${parts[1]}__*`) return true
    }
    return false
  }

  private matchBash(specifier: string, command: string): boolean {
    if (!specifier || specifier === '*') return true
    
    const normalizedCmd = command.trim()
    
    if (specifier.includes('*')) {
      const pattern = specifier.replace(/\*/g, '.*')
      const regex = new RegExp(`^${pattern}$`)
      return regex.test(normalizedCmd)
    }
    
    return normalizedCmd.includes(specifier)
  }

  private normalizePath(path: string, cwd: string): string {
    if (path.startsWith('/')) return path
    if (path.startsWith('~/')) return path.replace('~', process.env.HOME || '')
    if (path.startsWith('./')) return path.slice(2)
    return `${cwd}/${path}`
  }

  private matchPath(specifier: string, filePath: string, cwd: string): boolean {
    if (!specifier) return true
    
    const normalizedPath = this.normalizePath(filePath, cwd)
    const normalizedPattern = this.normalizePath(specifier, cwd)
    
    const toGlob = (pattern: string) => {
      let glob = pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '{{GLOB}}')
        .replace(/\*/g, '[^/]*')
        .replace(/{{GLOB}}/g, '.*')
      return new RegExp(`^${glob}$`)
    }
    
    return toGlob(normalizedPattern).test(normalizedPath)
  }

  private matchWebFetch(specifier: string, url: string): boolean {
    if (!specifier) return true
    
    const domainMatch = specifier.match(/domain:(.+)/)
    if (domainMatch) {
      const domain = domainMatch[1]
      return url.includes(domain)
    }
    
    return url.includes(specifier)
  }

  private matchRule(rule: PermissionRule, toolName: string, toolInput: Record<string, any>, cwd: string): boolean {
    if (!this.matchTool(rule.tool, toolName)) return false
    
    if (!rule.specifier) return true
    
    if (toolName === 'Bash' || rule.tool === 'Bash') {
      return this.matchBash(rule.specifier, toolInput.command || '')
    }
    
    if (rule.tool === 'Read' || rule.tool === 'Edit' || rule.tool === 'Write') {
      return this.matchPath(rule.specifier, toolInput.filePath || '', cwd)
    }
    
    if (rule.tool === 'WebFetch') {
      return this.matchWebFetch(rule.specifier, toolInput.url || '')
    }
    
    return true
  }

  checkPermission(toolName: string, toolInput: Record<string, any>, cwd: string = process.cwd()): PermissionCheckResult {
    if (READONLY_TOOLS.has(toolName)) {
      return { decision: 'allow', source: 'readonly' }
    }

    if (toolName === 'Bash') {
      const command = (toolInput.command || '').split(/[;&|]/)[0].trim()
      const baseCmd = command.split(' ')[0]
      if (READONLY_BASH_COMMANDS.has(baseCmd) || READONLY_BASH_COMMANDS.has(command)) {
        return { decision: 'allow', source: 'readonly' }
      }
    }

    if (this.mode === 'plan') {
      if (toolName === 'Bash' || toolName === 'Write' || toolName === 'Edit') {
        return { decision: 'deny', rule: 'Plan mode', source: 'deny' }
      }
    }

    if (this.mode === 'dontAsk') {
      return { decision: 'deny', rule: 'dontAsk mode', source: 'deny' }
    }

    if (this.mode === 'acceptEdits') {
      if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Bash') {
        return { decision: 'allow', source: 'acceptEdits' }
      }
    }

    const key = `${toolName}:${JSON.stringify(toolInput)}`
    if (this.sessionAllowed.has(key)) {
      return { decision: 'allow', source: 'session' }
    }
    if (this.sessionDenied.has(key)) {
      return { decision: 'deny', source: 'session' }
    }

    for (const rule of this.rules.deny) {
      const parsed = this.parseRule(rule)
      if (this.matchRule(parsed, toolName, toolInput, cwd)) {
        return { decision: 'deny', rule, source: 'deny' }
      }
    }

    for (const rule of this.rules.allow) {
      const parsed = this.parseRule(rule)
      if (this.matchRule(parsed, toolName, toolInput, cwd)) {
        return { decision: 'allow', rule, source: 'allow' }
      }
    }

    for (const rule of this.rules.ask) {
      const parsed = this.parseRule(rule)
      if (this.matchRule(parsed, toolName, toolInput, cwd)) {
        return { decision: 'ask', rule, source: 'ask' }
      }
    }

    if (toolName === 'Bash' || toolName === 'Write' || toolName === 'Edit') {
      return { decision: 'ask' }
    }

    return { decision: 'allow' }
  }

  async requestPermission(request: PermissionRequest): Promise<PermissionResponse> {
    if (!this.onPermissionRequest) {
      return { allowed: false, option: 'reject_once' }
    }
    return this.onPermissionRequest(request)
  }

  addSessionRule(toolName: string, toolInput: Record<string, any>, allowed: boolean) {
    const key = `${toolName}:${JSON.stringify(toolInput)}`
    if (allowed) {
      this.sessionAllowed.add(key)
    } else {
      this.sessionDenied.add(key)
    }
  }

  clearSessionRules() {
    this.sessionAllowed.clear()
    this.sessionDenied.clear()
  }
}

export const permissionManager = new PermissionManager()
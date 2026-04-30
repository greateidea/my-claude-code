import { AVAILABLE_TOOLS, findToolByName, type Tool, type ToolInput } from '../tools'

export interface ToolCall {
  id: string
  name: string
  input: ToolInput
}

export interface ToolResult {
  id: string
  name: string
  input: ToolInput
  result: string
  error?: string
}

export interface ToolExecutionStep {
  type: 'tool' | 'result' | 'error' | 'permission' | 'permission_response'
  toolCall?: ToolCall
  result?: string
  error?: string
  permissionRequest?: {
    toolName: string
    toolInput: Record<string, any>
    title: string
    description: string
  }
  permissionResponse?: {
    allowed: boolean
    option: string
  }
}

export interface ToolBatch {
  isConcurrencySafe: boolean
  calls: ToolCall[]
}

export interface PermissionCheckResult {
  decision: 'allow' | 'deny' | 'ask'
  rule?: string
  result?: string
}

export interface PermissionHandler {
  check: (toolName: string, toolInput: Record<string, any>, cwd: string) => PermissionCheckResult
  request: (request: { toolName: string; toolInput: Record<string, any>; title: string; description: string }) => Promise<{ allowed: boolean; option: string }>
}

class Semaphore {
  private permits: number
  private waitQueue: Array<() => void> = []

  constructor(permits: number) {
    this.permits = permits
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve)
    })
  }

  release(): void {
    this.permits++
    const next = this.waitQueue.shift()
    if (next) {
      this.permits--
      next()
    }
  }
}

function isInputConcurrencySafe(tool: Tool | undefined, input: ToolInput): boolean {
  if (!tool?.isConcurrencySafe) return false
  try {
    return tool.isConcurrencySafe(input)
  } catch {
    return false
  }
}

export function partitionToolCalls(calls: ToolCall[]): ToolBatch[] {
  return calls.reduce((acc: ToolBatch[], call) => {
    const tool = findToolByName(AVAILABLE_TOOLS, call.name)
    const isSafe = isInputConcurrencySafe(tool, call.input)
    
    if (isSafe && acc.length > 0 && acc[acc.length - 1]!.isConcurrencySafe) {
      acc[acc.length - 1]!.calls.push(call)
    } else {
      acc.push({ isConcurrencySafe: isSafe, calls: [call] })
    }
    return acc
  }, [])
}

const MAX_CONCURRENCY = 10

async function executeSingleTool(
  call: ToolCall,
  executeFn: (name: string, input: Record<string, any>) => Promise<string>
): Promise<ToolResult> {
  const tool = findToolByName(AVAILABLE_TOOLS, call.name)
  
  if (!tool) {
    return {
      id: call.id,
      name: call.name,
      input: call.input,
      result: '',
      error: `Tool "${call.name}" not found`,
    }
  }

  try {
    const result = await executeFn(call.name, call.input as Record<string, any>)
    return { id: call.id, name: call.name, input: call.input, result }
  } catch (e: any) {
    return {
      id: call.id,
      name: call.name,
      input: call.input,
      result: '',
      error: e.message,
    }
  }
}

export async function* executeToolsSerially(
  calls: ToolCall[],
  executeFn: (name: string, input: Record<string, any>) => Promise<string>,
  permissionHandler?: PermissionHandler,
  cwd?: string,
): AsyncGenerator<ToolExecutionStep> {
  for (const call of calls) {
    yield { type: 'tool', toolCall: call }
    
    let result: string
    
    if (permissionHandler) {
      const permResult = permissionHandler.check(call.name, call.input as Record<string, any>, cwd || process.cwd())
      
      if (permResult.decision === 'deny') {
        result = permResult.result || 'Permission denied'
      } else if (permResult.decision === 'ask' && permissionHandler.request) {
        yield {
          type: 'permission',
          permissionRequest: {
            toolName: call.name,
            toolInput: call.input as Record<string, any>,
            title: call.name,
            description: JSON.stringify(call.input),
          }
        }
        
        const response = await permissionHandler.request({
          toolName: call.name,
          toolInput: call.input as Record<string, any>,
          title: call.name,
          description: JSON.stringify(call.input),
        })
        
        yield { type: 'permission_response', permissionResponse: response }
        
        if (!response.allowed) {
          result = 'Permission denied by user'
        } else {
          const execResult = await executeFn(call.name, call.input as Record<string, any>)
          result = execResult
        }
      } else {
        const execResult = await executeFn(call.name, call.input as Record<string, any>)
        result = execResult
      }
    } else {
      const execResult = await executeFn(call.name, call.input as Record<string, any>)
      result = execResult
    }

    yield { type: 'result', result, toolCall: call }
  }
}

export async function* executeToolsConcurrently(
  calls: ToolCall[],
  executeFn: (name: string, input: Record<string, any>) => Promise<string>,
  permissionHandler?: PermissionHandler,
  cwd?: string,
): AsyncGenerator<ToolExecutionStep> {
  // 阶段1: 串行检查所有权限 (避免并发权限对话框)
  const readyCalls: Array<{ call: ToolCall; result?: string }> = []
  
  for (const call of calls) {
    if (permissionHandler) {
      const permResult = permissionHandler.check(call.name, call.input as Record<string, any>, cwd || process.cwd())
      
      if (permResult.decision === 'deny') {
        yield { type: 'tool', toolCall: call }
        yield { type: 'result', result: permResult.result || 'Permission denied', toolCall: call }
      } else if (permResult.decision === 'ask' && permissionHandler.request) {
        yield {
          type: 'permission',
          permissionRequest: {
            toolName: call.name,
            toolInput: call.input as Record<string, any>,
            title: call.name,
            description: JSON.stringify(call.input),
          }
        }
        
        const response = await permissionHandler.request({
          toolName: call.name,
          toolInput: call.input as Record<string, any>,
          title: call.name,
          description: JSON.stringify(call.input),
        })
        
        yield { type: 'permission_response', permissionResponse: response }
        
        if (response.allowed) {
          readyCalls.push({ call })
        } else {
          yield { type: 'tool', toolCall: call }
          yield { type: 'result', result: 'Permission denied by user', toolCall: call }
        }
      } else {
        readyCalls.push({ call })
      }
    } else {
      readyCalls.push({ call })
    }
  }

  // 阶段2: 并行执行已获授权的工具
  if (readyCalls.length === 0) return

  const sem = new Semaphore(MAX_CONCURRENCY)
  const pendingCalls = [...readyCalls]
  const running: Array<{
    call: ToolCall
    promise: Promise<ToolExecutionStep>
  }> = []

  while (pendingCalls.length > 0 || running.length > 0) {
    while (pendingCalls.length > 0 && running.length < MAX_CONCURRENCY) {
      const { call } = pendingCalls.shift()!
      
      const task = (async (): Promise<ToolExecutionStep> => {
        await sem.acquire()
        try {
          const execResult = await executeFn(call.name, call.input as Record<string, any>)
          return { type: 'result' as const, result: execResult, toolCall: call }
        } finally {
          sem.release()
        }
      })()

      running.push({ call, promise: task })
    }

    if (running.length === 0) break

    const done = await Promise.race(running.map(r => r.promise))
    const doneIndex = running.findIndex(r => r.promise === Promise.resolve(done))
    if (doneIndex >= 0) running.splice(doneIndex, 1)

    yield { type: 'tool', toolCall: done.toolCall }
    yield done
  }
}

export async function* runToolCalls(
  calls: ToolCall[],
  executeFn: (name: string, input: Record<string, any>) => Promise<string>,
  permissionHandler?: PermissionHandler,
  cwd?: string,
): AsyncGenerator<ToolExecutionStep> {
  if (calls.length === 0) {
    return
  }

  const batches = partitionToolCalls(calls)

  for (const batch of batches) {
    if (batch.isConcurrencySafe && batch.calls.length > 1) {
      yield* executeToolsConcurrently(batch.calls, executeFn, permissionHandler, cwd)
    } else {
      yield* executeToolsSerially(batch.calls, executeFn, permissionHandler, cwd)
    }
  }
}

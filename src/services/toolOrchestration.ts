import { z } from 'zod'
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
  type: 'tool' | 'result' | 'error'
  toolCall?: ToolCall
  result?: string
  error?: string
}

interface ToolBatch {
  isConcurrencySafe: boolean
  calls: ToolCall[]
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

function parseToolCalls(content: string): ToolCall[] {
  const results: ToolCall[] = []
  
  // 解析 JSON 格式的工具调用: {"name": "bash", "arguments": {...}}
  const jsonRegex = /<tool_call>\s*(\w+)\s*\{([^}]+)\}\s*<\/tool_call>/g
  let match
  while ((match = jsonRegex.exec(content)) !== null) {
    const name = match[1]
    try {
      const args = JSON.parse('{' + match[2] + '}')
      results.push({
        id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name,
        input: args,
      })
    } catch {}
  }

  // 解析 XML 格式的工具调用
  const xmlRegex = /<tool name="(\w+)">([\s\S]*?)<\/tool>/g
  while ((match = xmlRegex.exec(content)) !== null) {
    const name = match[1]
    const body = match[2]
    const input: Record<string, string> = {}
    const paramRegex = /<param name="([^"]+)">([^<]+)<\/param>/g
    let paramMatch
    while ((paramMatch = paramRegex.exec(body)) !== null) {
      input[paramMatch[1]] = paramMatch[2]
    }
    results.push({
      id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name,
      input,
    })
  }

  return results
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
const semaphore = new Semaphore(MAX_CONCURRENCY)

async function* all<T>(
  generators: AsyncGenerator<T>[],
  concurrency: number,
): AsyncGenerator<T> {
  const sem = new Semaphore(concurrency)
  const active: Promise<{ done: boolean; value: T }>[] = []
  const genDone = new Set<number>()

  function runGen(index: number, gen: AsyncGenerator<T>): Promise<{ done: boolean; value: T }> {
    return (async () => {
      try {
        const result = await gen.next()
        if (result.done) {
          genDone.add(index)
        }
        return { done: Boolean(result.done), value: result.value as T }
      } finally {
        sem.release()
      }
    })()
  }

  for (let i = 0; i < generators.length; i++) {
    if (active.length >= concurrency) {
      const result = await Promise.race(active)
      if (!result.done) {
        yield result.value
      }
    }
    
    await sem.acquire()
    active.push(runGen(i, generators[i]))
  }

  while (active.length > 0) {
    const result = await Promise.race(active)
    if (!result.done) {
      yield result.value
    }
    const idx = active.findIndex(p => p === Promise.resolve(result))
    if (idx >= 0) active.splice(idx, 1)
  }
}

async function executeSingleTool(call: ToolCall): Promise<ToolResult> {
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
    const result = await tool.execute(call.input)
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

async function* executeToolsSerially(
  calls: ToolCall[],
): AsyncGenerator<ToolExecutionStep> {
  for (const call of calls) {
    yield { type: 'tool', toolCall: call }
    const result = await executeSingleTool(call)
    if (result.error) {
      yield { type: 'error', error: result.error, toolCall: call }
    } else {
      yield { type: 'result', result: result.result, toolCall: call }
    }
  }
}

async function* executeToolsConcurrently(
  calls: ToolCall[],
): AsyncGenerator<ToolExecutionStep> {
  const sem = new Semaphore(MAX_CONCURRENCY)

  async function* runWithSemaphore(call: ToolCall): AsyncGenerator<ToolExecutionStep> {
    await sem.acquire()
    try {
      yield { type: 'tool', toolCall: call }
      const result = await executeSingleTool(call)
      if (result.error) {
        yield { type: 'error', error: result.error, toolCall: call }
      } else {
        yield { type: 'result', result: result.result, toolCall: call }
      }
    } finally {
      sem.release()
    }
  }

  const generators = calls.map(call => runWithSemaphore(call))

  for await (const step of all(generators, MAX_CONCURRENCY)) {
    yield step
  }
}

export async function* runToolCalls(
  content: string,
): AsyncGenerator<ToolExecutionStep> {
  const calls = parseToolCalls(content)
  
  if (calls.length === 0) {
    return
  }

  const batches = partitionToolCalls(calls)

  for (const batch of batches) {
    if (batch.isConcurrencySafe && batch.calls.length > 1) {
      yield* executeToolsConcurrently(batch.calls)
    } else {
      yield* executeToolsSerially(batch.calls)
    }
  }
}

export function hasToolCalls(content: string): boolean {
  return parseToolCalls(content).length > 0
}
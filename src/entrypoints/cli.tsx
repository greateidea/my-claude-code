#!/usr/bin/env bun

process.env.COREPACK_ENABLE_AUTO_PIN = '0'

const MACRO = {
  VERSION: '0.1.0',
}

interface ParsedArgs {
  command: string
  prompt?: string
  continueSession?: boolean
  resumeSessionId?: string
  listSessions?: boolean
  clearSessions?: boolean
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2)
  const realArgs = args.filter(arg => !arg.includes('cli.tsx') && !arg.includes('entrypoints'))

  const result: ParsedArgs = { command: 'chat' }

  let i = 0
  const positional: string[] = []

  while (i < realArgs.length) {
    const arg = realArgs[i]

    if (arg === '--continue' || arg === '-c') {
      result.continueSession = true
      i++
    } else if (arg === '--resume' || arg === '-r') {
      result.resumeSessionId = realArgs[i + 1] || ''
      i += 2
    } else if (arg === '--list-sessions' || arg === '-ls') {
      result.listSessions = true
      i++
    } else if (arg === '--clear-sessions' || arg === '--clear') {
      result.clearSessions = true
      i++
    } else if (arg === 'chat' || arg === 'doctor' || arg === '--version' || arg === '-v' || arg === '--help' || arg === '-h') {
      result.command = arg
      i++
    } else {
      positional.push(arg)
      i++
    }
  }

  if (positional.length > 0) {
    result.prompt = positional.join(' ')
  }

  return result
}

function printHelp(): void {
  console.log(`My Claude Code ${MACRO.VERSION}

Usage: myclaude [options] [prompt]
       myclaude [options] chat [prompt]

Options:
  -c, --continue        Continue the most recent session
  -r, --resume <id>     Resume a specific session by ID
  -ls, --list-sessions  List all sessions for the current project
  --clear, --clear-sessions  Clear all session records for the current project
  -h, --help            Show this help
  -v, --version         Show version

Examples:
  myclaude "fix the login bug"     One-shot message
  myclaude                         Start interactive REPL
  myclaude --continue              Continue last session
  myclaude --resume abc123         Resume session abc123
  myclaude --list-sessions         List all sessions
`)
}

async function main(): Promise<void> {
  const parsed = parseArgs()

  if (parsed.command === '--version' || parsed.command === '-v') {
    console.log(`${MACRO.VERSION} (My Claude Code)`)
    return
  }

  if (parsed.command === '--help' || parsed.command === '-h') {
    printHelp()
    return
  }

  if (parsed.command === 'doctor') {
    console.log('Running doctor...')
    return
  }

  if (parsed.clearSessions) {
    const { rm, readdir } = await import('fs/promises')
    const { join } = await import('path')
    const { getProjectDir, getSessionsDir } = await import('../services/paths')

    const projectDir = getProjectDir(process.cwd())
    const sessionsDir = getSessionsDir()

    let deletedCount = 0

    // Clear all JSONL session files in the project directory
    try {
      const files = await readdir(projectDir)
      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          await rm(join(projectDir, file))
          deletedCount++
        }
      }
    } catch {
      // Directory doesn't exist — that's fine
    }

    // Clear PID registry files
    try {
      const pidFiles = await readdir(sessionsDir)
      for (const file of pidFiles) {
        await rm(join(sessionsDir, file))
      }
    } catch {
      // Directory doesn't exist — that's fine
    }

    console.log(`Cleared ${deletedCount} session record(s) and PID files.`)
    return
  }

  if (parsed.listSessions) {
    const { listSessions } = await import('../services/persistence')
    const sessions = await listSessions(process.cwd())
    if (sessions.length === 0) {
      console.log('No sessions found for this project.')
    } else {
      console.log(`Sessions for ${process.cwd()}:\n`)
      for (const s of sessions) {
        const date = new Date(s.lastTimestamp).toLocaleString()
        console.log(`  ${s.sessionId}  ${date}  ${s.messageCount} messages`)
      }
      console.log(`\n${sessions.length} session(s). Use --resume <id> to resume one, or --continue for the latest.`)
    }
    return
  }

  const { main: chatMain } = await import('../main')
  await chatMain(parsed.prompt, {
    continueSession: parsed.continueSession,
    resumeSessionId: parsed.resumeSessionId,
  })
}

void main()

#!/usr/bin/env bun

process.env.COREPACK_ENABLE_AUTO_PIN = '0'

const MACRO = {
  VERSION: '0.1.0',
}

function parseArgs(): { command: string; prompt?: string } {
  const args = process.argv.slice(2)
  const realArgs = args.filter(arg => !arg.includes('cli.tsx') && !arg.includes('entrypoints'))
  
  if (realArgs.length === 0) return { command: 'chat' }
  
  const firstArg = realArgs[0]
  if (firstArg === 'chat' || firstArg === 'doctor' || firstArg === '--version' || firstArg === '-v') {
    return { command: firstArg, prompt: realArgs[1] }
  }
  return { command: 'chat', prompt: firstArg }
}

async function main(): Promise<void> {
  const { command, prompt } = parseArgs()

  if (command === '--version' || command === '-v') {
    console.log(`${MACRO.VERSION} (My Claude Code)`)
    return
  }

  if (command === 'doctor') {
    console.log('Running doctor...')
    return
  }

  const { main: chatMain } = await import('../main')
  await chatMain(prompt)
}

void main()
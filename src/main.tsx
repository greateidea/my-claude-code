import { launchRepl, type LaunchOptions } from './replLauncher'

export async function main(prompt?: string, opts?: { continueSession?: boolean; resumeSessionId?: string }) {
  await launchRepl({
    prompt,
    continueSession: opts?.continueSession,
    resumeSessionId: opts?.resumeSessionId,
  })
}

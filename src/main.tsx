import { launchRepl } from './replLauncher'

export async function main(prompt?: string) {
  await launchRepl({ prompt })
}
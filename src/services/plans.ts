import { randomUUID } from 'crypto'
import { join } from 'path'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { getMyClaudeDir } from './paths'

// ---- Slug generation ----

// Three word lists for readable plan slugs (like "whimsical-questing-sketch")
const ADJECTIVES = [
  'bright', 'calm', 'cool', 'dark', 'deep', 'eager', 'fair', 'fine', 'free',
  'glad', 'grand', 'green', 'happy', 'keen', 'kind', 'light', 'lucky', 'neat',
  'nice', 'odd', 'pale', 'pink', 'proud', 'pure', 'quick', 'quiet', 'rare',
  'red', 'rich', 'sharp', 'shy', 'sly', 'smart', 'soft', 'still', 'sunny',
  'sweet', 'tall', 'tame', 'tidy', 'tiny', 'tough', 'true', 'vast', 'warm',
  'wild', 'wise', 'bold', 'brave', 'brisk', 'clean', 'crisp', 'fresh',
]

const GERUNDS = [
  'baking', 'bending', 'blooming', 'bouncing', 'brewing', 'building', 'buzzing',
  'catching', 'chasing', 'cheering', 'climbing', 'coiling', 'cooking', 'crafting',
  'dancing', 'dashing', 'digging', 'diving', 'drawing', 'dreaming', 'drifting',
  'farming', 'fishing', 'flying', 'folding', 'gliding', 'glowing', 'growing',
  'hopping', 'humming', 'hunting', 'jumping', 'launching', 'leaping', 'lifting',
  'marching', 'melting', 'mending', 'mixing', 'nesting', 'painting', 'peeking',
  'plowing', 'polishing', 'printing', 'pulling', 'pushing', 'questing', 'racing',
  'resting', 'riding', 'roaming', 'rolling', 'rowing', 'running', 'sailing',
  'scooping', 'scouting', 'seeking', 'sewing', 'shaping', 'shifting', 'singing',
  'skating', 'sketching', 'skiing', 'slicing', 'soaring', 'spinning', 'splashing',
  'stacking', 'stirring', 'surfing', 'sweeping', 'swimming', 'swinging', 'tapping',
  'tending', 'trading', 'trailing', 'tuning', 'turning', 'twirling', 'walking',
  'washing', 'waving', 'weaving', 'whirling', 'winding', 'wishing', 'working',
  'writing', 'zooming',
]

const NOUNS = [
  'beach', 'bird', 'bloom', 'boat', 'breeze', 'brook', 'cabin', 'cactus',
  'canopy', 'castle', 'cave', 'cliff', 'cloud', 'coast', 'comet', 'copper',
  'coral', 'cove', 'creek', 'dawn', 'desert', 'dew', 'dune', 'dust', 'field',
  'flame', 'flower', 'forest', 'frost', 'garden', 'gem', 'glacier', 'grove',
  'harbor', 'haven', 'hawk', 'hill', 'hollow', 'horizon', 'island', 'ivy',
  'lagoon', 'lake', 'lantern', 'leaf', 'lily', 'lodge', 'maple', 'meadow',
  'mesa', 'mist', 'moon', 'moss', 'nest', 'oasis', 'ocean', 'orchard', 'path',
  'peak', 'pearl', 'pier', 'pine', 'pond', 'prairie', 'quarry', 'rain', 'reef',
  'ridge', 'river', 'rock', 'rose', 'shell', 'shore', 'sky', 'snow', 'spark',
  'star', 'stone', 'storm', 'storm', 'summit', 'sun', 'surf', 'swamp', 'thicket',
  'thorn', 'tide', 'timber', 'torch', 'trail', 'tree', 'valley', 'vine', 'wave',
  'wheat', 'willow', 'wind', 'wing', 'wood',
]

export function generatePlanSlug(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const ger = GERUNDS[Math.floor(Math.random() * GERUNDS.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  return `${adj}-${ger}-${noun}`
}

// ---- Paths ----

export function getPlansDir(): string {
  return join(getMyClaudeDir(), 'plans')
}

export function getPlanFilePath(agentId?: string): string {
  const dir = getPlansDir()
  // If no agent context, use a global plan file
  const filename = agentId ? `${agentId}.md` : 'current-plan.md'
  return join(dir, filename)
}

// ---- Plan file management ----

let _currentPlanPath: string | null = null

/** Get the plan file path for the active plan mode session. */
export function getCurrentPlanPath(): string | null {
  return _currentPlanPath
}

/** Create a new plan file and return its path. */
export function createPlanFile(): string {
  const dir = getPlansDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const slug = generatePlanSlug()
  const path = join(dir, `${slug}.md`)
  // Create with a placeholder so the file exists immediately
  writeFileSync(path, '# Plan\n\n', 'utf-8')
  _currentPlanPath = path
  return path
}

/** Read the current plan file content. */
export function getPlan(): string | null {
  const path = _currentPlanPath
  if (!path || !existsSync(path)) return null
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

/** Write content to the current plan file. */
export function writePlan(content: string): void {
  const path = _currentPlanPath
  if (!path) return
  writeFileSync(path, content, 'utf-8')
}

/** Clean up — forget the current plan path (file stays on disk). */
export function clearCurrentPlan(): void {
  _currentPlanPath = null
}

// ---- Plan approval handler (set by replLauncher) ----

type PlanApprovalHandler = (plan: string) => Promise<{ approved: boolean; feedback?: string }>

let _planApprovalHandler: PlanApprovalHandler | null = null

export function setPlanApprovalHandler(handler: PlanApprovalHandler): void {
  _planApprovalHandler = handler
}

export function getPlanApprovalHandler(): PlanApprovalHandler | null {
  return _planApprovalHandler
}

import { z } from 'zod'
import { type Tool } from './types'

export const EnterPlanModeTool: Tool = {
  name: 'EnterPlanMode',
  description: `Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment.

## When to Use This Tool

**Prefer using EnterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:

1. **New Feature Implementation**: Adding meaningful new functionality
2. **Multiple Valid Approaches**: The task can be solved in several different ways
3. **Code Modifications**: Changes that affect existing behavior or structure
4. **Architectural Decisions**: The task requires choosing between patterns or technologies
5. **Multi-File Changes**: The task will likely touch more than 2-3 files
6. **Unclear Requirements**: You need to explore before understanding the full scope
7. **User Preferences Matter**: The implementation could reasonably go multiple ways

## When NOT to Use This Tool

Only skip EnterPlanMode for simple tasks:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- Adding a single function with clear requirements
- Pure research/exploration tasks

## What Happens in Plan Mode

In plan mode, you can only read/search files and write to the plan file. You cannot modify code or run Bash commands. Explore the codebase, design an approach, write the plan, then call ExitPlanMode for user approval.`,
  inputSchema: {},
  execute: async () => {
    const { permissionManager } = await import('../services/permissions')
    const { createPlanFile } = await import('../services/plans')

    if (permissionManager.getMode() === 'plan') {
      return 'Already in plan mode.'
    }

    // Save current mode for restoration on exit
    const prePlanMode = permissionManager.getMode()
    ;(permissionManager as any)._prePlanMode = prePlanMode

    permissionManager.setMode('plan')
    const planPath = createPlanFile()

    return `Entered plan mode. Plan file: ${planPath}

Plan mode is now active. You are in a read-only research phase:
1. Explore the codebase using Read/Glob/Grep tools
2. Design your implementation approach
3. Write your plan to the plan file using the Write tool (this is the ONLY file you may modify)
4. When your plan is complete, call ExitPlanMode to present it for user approval

Do NOT make any edits outside the plan file. Do NOT run Bash commands.`
  },
  isConcurrencySafe: () => false,
}

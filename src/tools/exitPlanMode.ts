import { z } from 'zod'
import { type Tool } from './types'

export const ExitPlanModeTool: Tool = {
  name: 'ExitPlanMode',
  description: `Use this tool when you are in plan mode and have finished your plan and are ready for user approval.

## How This Tool Works
- You can either write your plan to the plan file using the Write tool, OR pass your plan content directly as the planContent parameter.
- If you pass planContent, it will be written to the plan file automatically.
- This tool signals that you're done planning and ready for the user to review and approve.
- The user will see the contents of your plan when they review it.

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous. Pass your plan as the planContent parameter, or write it to the plan file first with the Write tool. Once your plan is finalized, use THIS tool to request approval.

## Examples
1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.`,
  inputSchema: {
    planContent: z.string().describe('Your plan content as markdown. If provided, it will be written to the plan file.').optional(),
  },
  execute: async (input) => {
    const { permissionManager } = await import('../services/permissions')
    const { getPlan, getPlanApprovalHandler, writePlan } = await import('../services/plans')

    if (permissionManager.getMode() !== 'plan') {
      return 'You are not in plan mode. This tool is only for exiting plan mode after writing a plan.'
    }

    // If plan content was passed as parameter, write it to the plan file
    if (input.planContent && input.planContent.trim()) {
      writePlan(input.planContent)
    }

    const plan = getPlan()
    if (!plan || plan.trim() === '' || plan.trim() === '# Plan\n\n') {
      return 'No plan found. Please pass your plan as the planContent parameter, or write it to the plan file using the Write tool before calling ExitPlanMode.'
    }

    // Request user approval
    const handler = getPlanApprovalHandler()
    if (!handler) {
      // No handler registered — exit plan mode directly
      permissionManager.setMode((permissionManager as any)._prePlanMode || 'default')
      return 'Exited plan mode (no approval handler registered).'
    }

    const result = await handler(plan)

    if (result.approved) {
      const feedbackNote = result.feedback ? `\n\nUser feedback: ${result.feedback}` : ''

      if (result.clearContext) {
        // Clear context + auto mode: store plan for replLauncher to pick up,
        // switch to acceptEdits so subsequent tool calls are auto-approved.
        const { setPendingImplementation } = await import('../services/plans')
        setPendingImplementation(plan, result.feedback)
        permissionManager.setMode('acceptEdits')
        delete (permissionManager as any)._prePlanMode

        return `Clear context + auto mode activated.${feedbackNote}\n\nStarting fresh conversation to implement the plan.`
      }

      // Restore pre-plan mode
      const prePlanMode = (permissionManager as any)._prePlanMode || 'default'
      permissionManager.setMode(prePlanMode)
      delete (permissionManager as any)._prePlanMode

      return `User has approved your plan. You can now start coding.${feedbackNote}\n\n## Approved Plan:\n${plan}`
    } else {
      // User rejected — stay in plan mode
      const feedbackNote = result.feedback ? `\n\nUser feedback: ${result.feedback}` : ''
      return `User wants you to revise the plan.${feedbackNote}\n\nPlease update the plan file and call ExitPlanMode again when ready.`
    }
  },
  isConcurrencySafe: () => false,
}

import { z } from 'zod'
import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { type Tool, writeTool } from './types'

export const EditTool: Tool = {
  name: 'Edit',
  description: `Performs exact string replacements in files.

Usage:
- The edit will FAIL if old_string is not unique in the file.
  Either provide a larger string with more surrounding context to make it unique or use replace_all.
- Use replace_all for replacing and renaming strings across the file.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.`,
  inputSchema: {
    file_path: z.string().describe('The absolute path to the file to modify'),
    old_string: z.string().describe('The text to replace'),
    new_string: z.string().describe('The text to replace it with (must be different from old_string)'),
    replace_all: z.boolean().optional().describe('Replace all occurrences of old_string (default false)'),
  },
  execute: async ({ file_path, old_string, new_string, replace_all }) => {
    try {
      if (!file_path.startsWith('/')) {
        return `Error: file_path must be an absolute path, not a relative path. Got: ${file_path}`
      }
      if (!old_string) {
        return 'Error: old_string must not be empty'
      }
      if (old_string === new_string) {
        return 'Error: old_string and new_string must be different'
      }
      if (!existsSync(file_path)) {
        return `Error: File not found: ${file_path}`
      }

      const content = await readFile(file_path, 'utf-8')
      const count = content.split(old_string).length - 1

      if (count === 0) {
        return `Error: old_string not found in file. Make sure the string exactly matches (including whitespace).`
      }
      if (count > 1 && !replace_all) {
        return `Error: old_string appears ${count} times in file. Either set replace_all to true or add more surrounding context to make old_string unique.`
      }

      const newContent = replace_all
        ? content.replaceAll(old_string, new_string)
        : content.replace(old_string, new_string)

      await writeFile(file_path, newContent, 'utf-8')
      const replaced = replace_all ? count : 1
      return `Successfully replaced ${replaced} occurrence(s) in ${file_path}`
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
  ...writeTool(),
}

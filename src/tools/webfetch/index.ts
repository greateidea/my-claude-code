/**
 * WebFetch Tool
 *
 * Fetches content from a URL, converts HTML to Markdown, and returns
 * AI-processed results based on a user-provided prompt.
 *
 * Security:
 * - Validates URLs (blocks credentials, enforces length limits)
 * - Only follows same-host redirects (with www variance)
 * - Caches results for 15 minutes to reduce redundant requests
 * - Preapproved developer domains are auto-allowed
 */

import { z } from 'zod'
import { type Tool, readOnlyTool } from '../types'
import {
  getURLMarkdownContent,
  applyPromptToMarkdown,
  RedirectError,
  validateURL,
} from './utils'
import { isPreapprovedUrl } from './preapproved'

export const WebFetchTool: Tool = {
  name: 'WebFetch',
  description: `Fetches content from a specified URL and processes it using an AI model
- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to markdown
- Processes the content with the prompt using a small, fast model
- Returns the model's response about the content
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - The prompt should describe what information you want to extract from the page
  - This tool is read-only and does not modify any files
  - Results may be summarized if the content is very large
  - Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL
  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new WebFetch request with the redirect URL to fetch the content.
  - For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view, gh api).`,

  inputSchema: {
    url: z.string().describe('The URL to fetch content from'),
    prompt: z.string().describe('The prompt to run on the fetched content'),
  },

  execute: async ({ url, prompt }) => {
    // Validate URL
    if (!validateURL(url)) {
      return `Error: Invalid URL. URLs must be fully-formed, under 2000 characters, and contain no credentials.`
    }

    // Check if this is a preapproved domain for auto-allow behavior
    const isPreapproved = isPreapprovedUrl(url)

    const controller = new AbortController()
    const startTime = Date.now()

    try {
      // Fetch and convert to markdown
      const fetched = await getURLMarkdownContent(url, controller)
      const durationMs = Date.now() - startTime

      // Always apply the user's prompt via AI. The isPreapproved flag only
      // affects the summarization guidelines:
      //   - Preapproved (docs sites, GitHub, etc.): can quote code/docs freely
      //   - Non-preapproved (random websites): strict 125-char quote limit
      // This distinction prevents copyright issues when fetching arbitrary sites.
      const aiResult = await applyPromptToMarkdown(
        prompt,
        fetched.content,
        controller.signal,
        isPreapproved,
      )

      return `${aiResult}\n\n---\nFetched: ${url} | HTTP ${fetched.code} | ${(durationMs / 1000).toFixed(2)}s | ${(fetched.bytes / 1024).toFixed(1)}KB`
    } catch (e: any) {
      if (e instanceof RedirectError) {
        return `Redirect detected: The URL ${url} redirects to ${e.redirectUrl}. Please make a new WebFetch request with the redirect URL: ${e.redirectUrl}`
      }
      if (e.name === 'AbortError') {
        return 'Error: Fetch timed out or was aborted.'
      }
      return `Error: WebFetch failed — ${e.message}`
    }
  },

  ...readOnlyTool(),
}

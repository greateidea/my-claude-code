/**
 * WebSearch Tool
 *
 * Performs web searches and returns structured results with titles, URLs,
 * and snippets. Uses Bing as the search backend — no API keys required.
 *
 * IMPORTANT: After answering the user's question, the model MUST include
 * a "Sources:" section at the end of the response listing all relevant URLs
 * from the search results as markdown hyperlinks.
 */

import { z } from 'zod'
import { type Tool, readOnlyTool } from '../types'
import { BingSearchAdapter } from './bing'
import type { SearchResult } from './types'

const bingAdapter = new BingSearchAdapter()

export const WebSearchTool: Tool = {
  name: 'WebSearch',
  description: `- Allows MyClaude to search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks, including links as markdown hyperlinks
- Use this tool for accessing information beyond Claude's knowledge cutoff
- Searches are performed automatically within a single API call

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response
  - Example format:

    [Your answer here]

    Sources:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)

Usage notes:
  - Domain filtering is supported to include or block specific websites
  - Web search is only available in the US and CN`,

  inputSchema: {
    query: z.string().min(2).describe('The search query to use'),
    allowed_domains: z.array(z.string()).optional().describe('Only include search results from these domains'),
    blocked_domains: z.array(z.string()).optional().describe('Never include search results from these domains'),
  },

  execute: async ({ query, allowed_domains, blocked_domains }) => {
    if (allowed_domains?.length && blocked_domains?.length) {
      return 'Error: Cannot specify both allowed_domains and blocked_domains simultaneously.'
    }

    const startTime = Date.now()

    try {
      const results: SearchResult[] = await bingAdapter.search(query, {
        allowedDomains: allowed_domains,
        blockedDomains: blocked_domains,
      })

      const durationSeconds = ((Date.now() - startTime) / 1000).toFixed(2)

      if (results.length === 0) {
        return `No search results found for "${query}".`
      }

      // Format results as search result blocks
      const formatted = results
        .map((r, i) => {
          const snippet = r.snippet ? `\n  ${r.snippet}` : ''
          return `${i + 1}. [${r.title}](${r.url})${snippet}`
        })
        .join('\n\n')

      return `Found ${results.length} search results for "${query}" (${durationSeconds}s):\n\n${formatted}\n\nREMINDER: You MUST include a "Sources:" section at the end of your response listing the relevant URLs as markdown hyperlinks.`
    } catch (e: any) {
      if (e.name === 'AbortError') {
        return 'Error: Search request was aborted or timed out.'
      }
      return `Error: Search failed — ${e.message}`
    }
  },

  ...readOnlyTool(),
}

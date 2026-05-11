/**
 * Bing Web Search Adapter
 *
 * Scrapes Bing.com search result pages by fetching the raw HTML and extracting
 * organic results with regex pattern matching on <li class="b_algo"> blocks.
 *
 * Adapted from Claude Code's bingAdapter.ts. Uses Bun's native fetch instead
 * of axios. No commercial search API keys required — pure web scraping.
 *
 * Bing in China: www.bing.com is generally accessible from mainland China.
 * If blocked, cn.bing.com can serve as a fallback (set BING_BASE_URL env var).
 */

import type { SearchResult, SearchOptions, WebSearchAdapter } from './types'

// ─── Constants ───────────────────────────────────────────────────────────────

/** Timeout for the Bing HTTP request (30 seconds) */
const FETCH_TIMEOUT_MS = 30_000

/** Base URL for Bing search — override via BING_BASE_URL env var (e.g. cn.bing.com) */
const BING_BASE_URL = process.env.BING_BASE_URL || 'https://www.bing.com'

/**
 * Browser-like headers to avoid Bing's anti-bot JS-rendered response.
 * These mimic Microsoft Edge on macOS to get full HTML search results
 * instead of a noscript fallback page.
 */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
}

// ─── HTML Entity Decoder ──────────────────────────────────────────────────────

/**
 * Decode common HTML named entities and numeric entities.
 * Handles the subset found in Bing search results without needing the `he` package.
 */
function decodeHtmlEntities(text: string): string {
  return text
    // Numeric entities: &#39; &#x27; &#1234; etc.
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    // Common named entities found in Bing results
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&copy;/g, '\u00A9')
    .replace(/&reg;/g, '\u00AE')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&ldquo;/g, '\u201C')
    .replace(/&rdquo;/g, '\u201D')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&hellip;/g, '\u2026')
}

// ─── Bing URL Resolution ─────────────────────────────────────────────────────

/**
 * Resolve a Bing redirect URL to the actual target URL.
 *
 * Bing wraps external links in redirect URLs like:
 *   https://www.bing.com/ck/a?...&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9wYXRo...
 *
 * The `u` query parameter is a base64url-encoded URL prefixed with:
 *   - a1 → https
 *   - a0 → http
 *
 * Returns undefined for Bing-internal or relative links that should be skipped.
 */
function resolveBingUrl(rawUrl: string): string | undefined {
  // Skip relative / anchor / Bing-internal links
  if (rawUrl.startsWith('/') || rawUrl.startsWith('#')) return undefined

  // Try to extract and decode the `u` parameter from Bing redirect URLs
  const uMatch = rawUrl.match(/[?&]u=([a-zA-Z0-9+/_-]+)/)
  if (uMatch) {
    const encoded = uMatch[1]
    if (encoded.length >= 3) {
      // First 2 chars are the protocol prefix, rest is base64url
      const b64 = encoded.slice(2)
      try {
        // Base64url → standard base64, then decode
        const padded = b64.replace(/-/g, '+').replace(/_/g, '/')
        const decoded = Buffer.from(padded, 'base64').toString('utf-8')
        if (decoded.startsWith('http')) return decoded
      } catch {
        // Not a valid base64 redirect — fall through
      }
    }
  }

  // Direct external URL (not a Bing-internal page)
  if (!rawUrl.includes('bing.com')) return rawUrl

  return undefined
}

// ─── Bing HTML Parsing ───────────────────────────────────────────────────────

/**
 * Extract organic search results from Bing HTML.
 *
 * Bing renders organic results as <li class="b_algo"> blocks inside
 * <ol id="b_results">. Each block contains:
 *   - <h2><a href="...">title</a></h2> — the result link and title
 *   - <p class="b_lineclamp..."> — snippet text (primary)
 *   - <div class="b_caption"><p> — snippet text (fallback)
 */
function extractSnippet(block: string): string | undefined {
  // Tier 1: <p class="b_lineclamp..."> — the standard snippet element
  const lineclampRegex = /<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i
  let match = lineclampRegex.exec(block)
  if (match) {
    return decodeHtmlEntities(match[1].replace(/<[^>]+>/g, '').trim())
  }

  // Tier 2: <div class="b_caption"> → <p> nested inside
  const captionPRegex = /<div[^>]*class="b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i
  match = captionPRegex.exec(block)
  if (match) {
    return decodeHtmlEntities(match[1].replace(/<[^>]+>/g, '').trim())
  }

  // Tier 3: <div class="b_caption"> direct text content (no inner <p>)
  const fallbackRegex = /<div[^>]*class="b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  const fallbackMatch = fallbackRegex.exec(block)
  if (fallbackMatch) {
    const text = fallbackMatch[1].replace(/<[^>]+>/g, '').trim()
    if (text) return decodeHtmlEntities(text)
  }

  return undefined
}

/**
 * Parse Bing's search result HTML into structured SearchResult objects.
 *
 * Uses regex matching on <li class="b_algo"> blocks — this is a deliberate
 * choice over DOM parsing: it's fast, has zero dependencies, and Bing's
 * result page structure is stable enough for regex extraction.
 */
export function extractBingResults(html: string): SearchResult[] {
  const results: SearchResult[] = []

  // Match each organic result block: <li class="b_algo" ...> ... </li>
  const algoBlockRegex = /<li\s+class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi
  let blockMatch: RegExpExecArray | null

  while ((blockMatch = algoBlockRegex.exec(html)) !== null) {
    const block = blockMatch[1]

    // Extract the primary link from <h2><a href="...">title text</a></h2>
    const h2LinkRegex = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
    const linkMatch = h2LinkRegex.exec(block)
    if (!linkMatch) continue

    const rawUrl = decodeHtmlEntities(linkMatch[1])
    const titleHtml = linkMatch[2]

    // Resolve Bing redirect URL → real destination
    const url = resolveBingUrl(rawUrl)
    if (!url) continue

    // Strip any remaining HTML tags from title
    const title = decodeHtmlEntities(titleHtml.replace(/<[^>]+>/g, '').trim())

    // Extract the snippet text
    const snippet = extractSnippet(block)

    results.push({ title, url, snippet })
  }

  return results
}

// ─── Bing Search Adapter ─────────────────────────────────────────────────────

/**
 * BingSearchAdapter — fetches Bing search result pages and extracts
 * structured results via HTML regex parsing.
 *
 * Domain filtering is applied client-side after extraction: allowedDomains
 * keeps only matching results, blockedDomains removes matching results.
 * Matching uses exact hostname or subdomain match (hostname ends with '.domain').
 */
export class BingSearchAdapter implements WebSearchAdapter {
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { signal, onProgress, allowedDomains, blockedDomains } = options

    if (signal?.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError')
    }

    onProgress?.({ type: 'query_update', query })

    const url = `${BING_BASE_URL}/search?q=${encodeURIComponent(query)}&setmkt=en-US`

    // Use AbortController to allow timeout + external signal to cancel the fetch
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    let html: string
    try {
      const response = await fetch(url, {
        headers: BROWSER_HEADERS,
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`Bing returned HTTP ${response.status}: ${response.statusText}`)
      }

      html = await response.text()
    } catch (e: any) {
      if (e.name === 'AbortError') {
        throw new DOMException('The operation was aborted', 'AbortError')
      }
      throw e
    } finally {
      clearTimeout(timeoutId)
    }

    if (controller.signal.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError')
    }

    // Extract results from the raw HTML
    const rawResults = extractBingResults(html)

    // Apply client-side domain filtering
    const results = rawResults.filter((r) => {
      if (!r.url) return false
      try {
        const hostname = new URL(r.url).hostname
        // Allowed domains: if specified, hostname must match (exact or subdomain)
        if (
          allowedDomains?.length &&
          !allowedDomains.some((d) => hostname === d || hostname.endsWith('.' + d))
        ) {
          return false
        }
        // Blocked domains: if hostname matches (exact or subdomain), exclude it
        if (
          blockedDomains?.length &&
          blockedDomains.some((d) => hostname === d || hostname.endsWith('.' + d))
        ) {
          return false
        }
      } catch {
        // URL parse failure → skip
        return false
      }
      return true
    })

    onProgress?.({
      type: 'search_results_received',
      resultCount: results.length,
      query,
    })

    return results
  }
}

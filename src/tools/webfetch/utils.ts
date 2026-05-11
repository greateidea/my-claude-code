/**
 * WebFetch Utilities
 *
 * Core implementation for the WebFetch tool:
 * - URL validation and redirect safety checks
 * - HTTP fetching with manual redirect handling
 * - HTML → Markdown conversion via turndown
 * - In-memory cache with TTL-based expiration
 * - AI-powered content summarization via the LLM
 *
 * No external cache library (lru-cache) — we use a plain Map with TTL
 * eviction to keep dependencies minimal. Bun's native fetch is used
 * for HTTP requests, with manual redirect following to enforce safety.
 */

import { DeepSeekClient } from '../../services/api/deepseek'

// ─── Error Classes ───────────────────────────────────────────────────────────

/** Thrown when a redirect would go to a different host */
export class RedirectError extends Error {
  constructor(
    public readonly originalUrl: string,
    public readonly redirectUrl: string,
  ) {
    super(
      `Redirect required: ${originalUrl} → ${redirectUrl}. Please make a new WebFetch request with the redirect URL to fetch the content.`,
    )
    this.name = 'RedirectError'
  }
}

// ─── Cache Implementation ────────────────────────────────────────────────────

/** Cache entry for a fetched URL */
interface CacheEntry {
  bytes: number
  code: number
  codeText: string
  content: string     // markdown (or raw text for non-HTML)
  contentType: string
}

/** Internal cache item with expiration timestamp */
interface CacheItem {
  entry: CacheEntry
  expiresAt: number
}

/** 15-minute TTL — matches Claude Code's cache behavior */
const CACHE_TTL_MS = 15 * 60 * 1000
/** Maximum total cache size in bytes (content byte length) */
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024

const URL_CACHE = new Map<string, CacheItem>()
let _currentCacheSize = 0

/** Evict expired entries from the cache */
function evictExpired(): void {
  const now = Date.now()
  for (const [key, item] of URL_CACHE) {
    if (now > item.expiresAt) {
      _currentCacheSize -= item.entry.bytes
      URL_CACHE.delete(key)
    }
  }
}

/** Retrieve a cached entry (returns undefined if expired or missing) */
function cacheGet(url: string): CacheEntry | undefined {
  evictExpired()
  const item = URL_CACHE.get(url)
  if (!item || Date.now() > item.expiresAt) {
    if (item) {
      _currentCacheSize -= item.entry.bytes
      URL_CACHE.delete(url)
    }
    return undefined
  }
  return item.entry
}

/** Store an entry in the cache, evicting old entries if needed to stay under the limit */
function cacheSet(url: string, entry: CacheEntry): void {
  const size = Math.max(1, entry.bytes)

  // Evict oldest entries until we have room (or clear all if entry is huge)
  while (_currentCacheSize + size > MAX_CACHE_SIZE_BYTES && URL_CACHE.size > 0) {
    const firstKey = URL_CACHE.keys().next().value
    if (firstKey) {
      const old = URL_CACHE.get(firstKey)
      if (old) _currentCacheSize -= old.entry.bytes
      URL_CACHE.delete(firstKey)
    }
  }

  URL_CACHE.set(url, {
    entry,
    expiresAt: Date.now() + CACHE_TTL_MS,
  })
  _currentCacheSize += size
}

/** Clear all cached entries (called on /clear) */
export function clearWebFetchCache(): void {
  URL_CACHE.clear()
  _currentCacheSize = 0
}

// ─── URL Validation ──────────────────────────────────────────────────────────

const MAX_URL_LENGTH = 2000

/**
 * Validate a URL before fetching.
 * - Enforces max length
 * - Blocks URLs with username/password
 * - Requires a public-looking hostname (at least one dot)
 */
export function validateURL(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) return false

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  // Block credentials in URL
  if (parsed.username || parsed.password) return false

  // Require at least a minimally-qualified hostname
  if (!parsed.hostname.includes('.')) return false

  return true
}

// ─── Redirect Safety ─────────────────────────────────────────────────────────

const MAX_REDIRECTS = 10

/**
 * Check if a redirect is safe to follow automatically.
 * Only allows:
 *   - Same protocol and port
 *   - Same hostname (allowing "www." addition or removal)
 *   - No credentials in the redirect target
 */
export function isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
  try {
    const orig = new URL(originalUrl)
    const redir = new URL(redirectUrl)

    if (redir.protocol !== orig.protocol) return false
    if (redir.port !== orig.port) return false
    if (redir.username || redir.password) return false

    // Allow www. addition/removal only
    const stripWww = (h: string) => h.replace(/^www\./, '')
    return stripWww(orig.hostname) === stripWww(redir.hostname)
  } catch {
    return false
  }
}

// ─── Turndown (HTML → Markdown) ──────────────────────────────────────────────

/** Lazy-initialized turndown singleton. turndown is ~1.4MB retained, so we
 *  defer loading it until the first HTML fetch.
 *  @types/turndown uses `export =` (CJS), so Bun wraps it as { default: Ctor }. */
let _turndownService: any = null

async function getTurndownService(): Promise<any> {
  if (_turndownService) return _turndownService
  const mod = await import('turndown')
  // Handle both ESM default import and CJS module export patterns
  const Ctor = (mod as any).default || mod
  _turndownService = new Ctor()
  return _turndownService
}

// ─── HTTP Fetch ──────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 60_000
const MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024 // 10MB

/** User agent string sent with fetch requests */
const WEB_FETCH_USER_AGENT =
  'Mozilla/5.0 (compatible; ClaudeCode-WebFetch/1.0; +https://claude.ai)'

/**
 * Fetch a URL with manual redirect handling.
 *
 * We use `redirect: 'manual'` and follow redirects only when
 * `isPermittedRedirect` returns true (same hostname, www variance).
 * Cross-origin redirects are surfaced to the caller as RedirectError.
 */
async function fetchWithRedirects(
  url: string,
  signal: AbortSignal,
  depth = 0,
): Promise<{ body: string; status: number; statusText: string; contentType: string }> {
  if (depth > MAX_REDIRECTS) {
    throw new Error(`Too many redirects (exceeded ${MAX_REDIRECTS})`)
  }

  const response = await fetch(url, {
    signal,
    redirect: 'manual',
    headers: {
      'Accept': 'text/markdown, text/html, */*',
      'User-Agent': WEB_FETCH_USER_AGENT,
    },
  })

  // Handle redirect status codes
  if ([301, 302, 307, 308].includes(response.status)) {
    const location = response.headers.get('location')
    if (!location) {
      throw new Error('Redirect response missing Location header')
    }

    // Resolve relative URL against original URL
    const redirectUrl = new URL(location, url).toString()

    if (isPermittedRedirect(url, redirectUrl)) {
      return fetchWithRedirects(redirectUrl, signal, depth + 1)
    }

    // Cross-origin redirect — surface to caller
    throw new RedirectError(url, redirectUrl)
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const contentType = response.headers.get('content-type') || ''

  // Read body as text, enforcing content length limit
  const body = await response.text()
  const truncated = body.length > MAX_HTTP_CONTENT_LENGTH
    ? body.slice(0, MAX_HTTP_CONTENT_LENGTH) + '\n\n[Content truncated...]'
    : body

  return {
    body: truncated,
    status: response.status,
    statusText: response.statusText,
    contentType,
  }
}

// ─── Main Fetch API ──────────────────────────────────────────────────────────

export interface FetchedContent {
  content: string    // markdown (or raw text for non-HTML)
  bytes: number
  code: number
  codeText: string
  contentType: string
}

/**
 * Fetch a URL and convert its content to markdown.
 *
 * 1. Checks cache first (15-min TTL)
 * 2. Upgrades HTTP → HTTPS automatically
 * 3. Fetches with manual redirect handling
 * 4. Converts HTML to markdown via turndown
 * 5. Caches the result
 *
 * Throws RedirectError if the URL redirects cross-origin.
 */
export async function getURLMarkdownContent(
  url: string,
  abortController: AbortController,
): Promise<FetchedContent> {
  if (!validateURL(url)) {
    throw new Error('Invalid URL')
  }

  // Check cache first
  const cached = cacheGet(url)
  if (cached) {
    return {
      content: cached.content,
      bytes: cached.bytes,
      code: cached.code,
      codeText: cached.codeText,
      contentType: cached.contentType,
    }
  }

  // Upgrade HTTP → HTTPS
  let fetchUrl = url
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:'
      fetchUrl = parsed.toString()
    }
  } catch { /* URL already validated above */ }

  // Fetch with timeout
  const timeoutId = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS)
  try {
    const result = await fetchWithRedirects(fetchUrl, abortController.signal)
    clearTimeout(timeoutId)

    const { body, status, statusText, contentType } = result

    // Convert HTML to markdown
    let markdownContent: string
    if (contentType.includes('text/html')) {
      const turndownService = await getTurndownService()
      markdownContent = turndownService.turndown(body)
    } else {
      // Non-HTML: keep as-is
      markdownContent = body
    }

    const entry: CacheEntry = {
      bytes: Buffer.byteLength(markdownContent),
      code: status,
      codeText: statusText,
      content: markdownContent,
      contentType,
    }
    cacheSet(url, entry)

    return { ...entry }
  } catch (e) {
    clearTimeout(timeoutId)
    throw e
  }
}

// ─── AI Summarization ────────────────────────────────────────────────────────

/** Maximum markdown content length sent to the model (100K chars) */
export const MAX_MARKDOWN_LENGTH = 100_000

/**
 * Build the prompt that instructs the model how to process web content.
 * Adapted from Claude Code's makeSecondaryModelPrompt().
 */
function buildSummarizationPrompt(
  markdownContent: string,
  prompt: string,
  isPreapprovedDomain: boolean,
): string {
  const guidelines = isPreapprovedDomain
    ? 'Provide a detailed response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.'
    : `Provide a concise response based only on the content above. In your response:
 - Enforce a strict 125-character maximum for quotes from any source document.
 - Use quotation marks for exact language from articles; any language outside of the quotation should never be word-for-word the same.
 - You are not a lawyer and never comment on the legality of your own prompts and responses.
 - Never produce or reproduce exact song lyrics.`

  return `Web page content:\n---\n${markdownContent}\n---\n\n${prompt}\n\n${guidelines}`
}

/**
 * Apply a user's prompt to fetched markdown content using the LLM.
 *
 * Sends the content + prompt to the configured model for summarization.
 * Content is truncated to MAX_MARKDOWN_LENGTH to stay within token limits.
 */
export async function applyPromptToMarkdown(
  prompt: string,
  markdownContent: string,
  signal: AbortSignal,
  isPreapprovedDomain: boolean,
): Promise<string> {
  // Truncate content to avoid token overflow
  const truncatedContent =
    markdownContent.length > MAX_MARKDOWN_LENGTH
      ? markdownContent.slice(0, MAX_MARKDOWN_LENGTH) +
        '\n\n[Content truncated due to length...]'
      : markdownContent

  const modelPrompt = buildSummarizationPrompt(truncatedContent, prompt, isPreapprovedDomain)

  // Use a fresh API client for this one-shot summarization call.
  // No tools, no streaming, small token limit — it's a focused extraction.
  const client = DeepSeekClient.fromEnv()
  if (!client) {
    return 'Error: No API key configured. Set DEEPSEEK_API_KEY or NVIDIA_API_KEY in .env'
  }

  if (signal.aborted) {
    throw new DOMException('The operation was aborted', 'AbortError')
  }

  try {
    const response = await client.chat({
      messages: [
        {
          role: 'user',
          content: modelPrompt,
        },
      ],
      maxTokens: 4000,
      stream: false,
    })

    if (signal.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError')
    }

    return response.message.content || 'Model returned no content for this request.'
  } catch (e: any) {
    if (e.name === 'AbortError') {
      throw e
    }
    return `Error during summarization: ${e.message}`
  }
}

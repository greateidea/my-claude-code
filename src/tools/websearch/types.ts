/** A single search result from the web search. */
export interface SearchResult {
  /** Result title (from the search snippet heading) */
  title: string
  /** Destination URL (Bing redirect URLs are resolved to the real target) */
  url: string
  /** Extracted snippet text, if available */
  snippet?: string
}

/** Options passed to the search adapter. */
export interface SearchOptions {
  /** Domain whitelist — only results matching these domains (or subdomains) are kept */
  allowedDomains?: string[]
  /** Domain blacklist — results matching these domains (or subdomains) are removed */
  blockedDomains?: string[]
  /** AbortSignal for cancelling the in-flight HTTP request */
  signal?: AbortSignal
  /** Progress callbacks for the UI layer (optional, not used yet) */
  onProgress?: (event: SearchProgress) => void
}

export type SearchProgress =
  | { type: 'query_update'; query: string }
  | { type: 'search_results_received'; resultCount: number; query: string }

/** Abstraction for pluggable search backends (Bing, API, etc.) */
export interface WebSearchAdapter {
  search(query: string, options: SearchOptions): Promise<SearchResult[]>
}

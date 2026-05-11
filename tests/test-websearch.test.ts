/**
 * WebSearch unit tests
 *
 * Tests the pure functions from the Bing adapter:
 * - decodeHtmlEntities — HTML entity decoding
 * - resolveBingUrl — Bing redirect URL resolution
 * - extractBingResults — Bing HTML parsing
 *
 * Run: bun test tests/test-websearch.test.ts
 */
import { describe, it, expect } from 'bun:test'
import {
  decodeHtmlEntities,
  resolveBingUrl,
  extractBingResults,
} from '../src/tools/websearch/bing'

// ─── decodeHtmlEntities ──────────────────────────────────────────────────────

describe('decodeHtmlEntities', () => {
  it('decodes named entities', () => {
    expect(decodeHtmlEntities('&amp;')).toBe('&')
    expect(decodeHtmlEntities('&lt;div&gt;')).toBe('<div>')
    expect(decodeHtmlEntities('&quot;hello&quot;')).toBe('"hello"')
    expect(decodeHtmlEntities('&apos;test&apos;')).toBe("'test'")
    expect(decodeHtmlEntities('foo&nbsp;bar')).toBe('foo bar')
  })

  it('decodes numeric decimal entities', () => {
    expect(decodeHtmlEntities('&#60;div&#62;')).toBe('<div>')
    expect(decodeHtmlEntities('&#x27;&#x27;')).toBe("''")
  })

  it('decodes numeric hex entities', () => {
    expect(decodeHtmlEntities('&#x3C;div&#x3E;')).toBe('<div>')
    // &#x26; decodes to & first, then &amp; decodes to & in the chained pass
    expect(decodeHtmlEntities('&#x26;amp;')).toBe('&')
  })

  it('decodes typographic entities', () => {
    expect(decodeHtmlEntities('&mdash;')).toBe('\u2014')
    expect(decodeHtmlEntities('&ndash;')).toBe('\u2013')
    expect(decodeHtmlEntities('&ldquo;hi&rdquo;')).toBe('\u201Chi\u201D')
    expect(decodeHtmlEntities('&lsquo;hi&rsquo;')).toBe('\u2018hi\u2019')
    expect(decodeHtmlEntities('&hellip;')).toBe('\u2026')
  })

  it('passes through text with no entities', () => {
    expect(decodeHtmlEntities('plain text')).toBe('plain text')
    expect(decodeHtmlEntities('')).toBe('')
  })

  it('handles multiple entity types in one string', () => {
    const input = 'O&rsquo;Reilly &amp; Associates &mdash; &quot;The Best&quot;'
    const expected = `O\u2019Reilly & Associates \u2014 "The Best"`
    expect(decodeHtmlEntities(input)).toBe(expected)
  })
})

// ─── resolveBingUrl ──────────────────────────────────────────────────────────

describe('resolveBingUrl', () => {
  it('returns direct external URLs as-is', () => {
    expect(resolveBingUrl('https://example.com/page')).toBe('https://example.com/page')
    expect(resolveBingUrl('https://docs.python.org/3/library/re.html')).toBe(
      'https://docs.python.org/3/library/re.html',
    )
  })

  it('decodes Bing redirect URLs (a1 prefix = https)', () => {
    // "https://example.com" → base64url: aHR0cHM6Ly9leGFtcGxlLmNvbQ==
    const b64 = 'aHR0cHM6Ly9leGFtcGxlLmNvbS8'
    const b64url = b64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
    const result = resolveBingUrl(`https://www.bing.com/ck/a?u=a1${b64url}`)
    expect(result).toBe('https://example.com/')
  })

  it('decodes Bing redirect URLs (a0 prefix = http)', () => {
    const b64 = Buffer.from('http://example.com').toString('base64')
    const b64url = b64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
    const result = resolveBingUrl(`https://www.bing.com/ck/a?u=a0${b64url}`)
    expect(result).toBe('http://example.com')
  })

  it('returns undefined for relative links', () => {
    expect(resolveBingUrl('/search?q=test')).toBeUndefined()
    expect(resolveBingUrl('/images/search?q=cat')).toBeUndefined()
  })

  it('returns undefined for anchor links', () => {
    expect(resolveBingUrl('#top')).toBeUndefined()
  })

  it('returns undefined for other Bing-internal pages', () => {
    expect(resolveBingUrl('https://www.bing.com/maps')).toBeUndefined()
    expect(resolveBingUrl('https://www.bing.com/news')).toBeUndefined()
  })

  it('handles malformed base64 in u parameter gracefully', () => {
    const result = resolveBingUrl('https://www.bing.com/ck/a?u=a1!!!!not-valid-base64!!!')
    expect(result).toBeUndefined()
  })

  it('handles u parameter with base64url characters (+ → -, / → _)', () => {
    // URL with + in base64 becomes -, / becomes _ in base64url
    const standardB64 = 'aHR0cHM6Ly9leGFtcGxlLmNvbS9wYXRoP3E9dGVzdA=='
    const b64url = standardB64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
    const result = resolveBingUrl(`https://www.bing.com/ck/a?u=a1${b64url}`)
    expect(result).toBe('https://example.com/path?q=test')
  })
})

// ─── extractBingResults ──────────────────────────────────────────────────────

describe('extractBingResults', () => {
  it('returns empty array for empty HTML', () => {
    expect(extractBingResults('')).toEqual([])
    expect(extractBingResults('<html><body></body></html>')).toEqual([])
  })

  it('extracts a single search result', () => {
    const html = `
      <ol id="b_results">
        <li class="b_algo">
          <div class="b_title">
            <h2><a href="https://example.com">Example Title</a></h2>
          </div>
          <p class="b_lineclamp_1">This is the snippet text for the result.</p>
        </li>
      </ol>
    `
    const results = extractBingResults(html)
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Example Title')
    expect(results[0].url).toBe('https://example.com')
    expect(results[0].snippet).toBe('This is the snippet text for the result.')
  })

  it('extracts multiple search results', () => {
    const html = `
      <li class="b_algo">
        <h2><a href="https://example1.com">First Result</a></h2>
        <p class="b_lineclamp_2">Snippet one.</p>
      </li>
      <li class="b_algo">
        <h2><a href="https://example2.com">Second Result</a></h2>
        <p class="b_lineclamp_1">Snippet two.</p>
      </li>
      <li class="b_algo">
        <h2><a href="https://example3.com">Third Result</a></h2>
        <p class="b_lineclamp_1">Snippet three.</p>
      </li>
    `
    const results = extractBingResults(html)
    expect(results).toHaveLength(3)
    expect(results[0].title).toBe('First Result')
    expect(results[1].title).toBe('Second Result')
    expect(results[2].title).toBe('Third Result')
  })

  it('skips results without h2 link', () => {
    const html = `
      <li class="b_algo">
        <div>No link here</div>
      </li>
    `
    const results = extractBingResults(html)
    expect(results).toHaveLength(0)
  })

  it('resolves Bing redirect URLs in results', () => {
    const b64 = Buffer.from('https://destination.com').toString('base64')
    const b64url = b64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

    const html = `
      <li class="b_algo">
        <h2><a href="https://www.bing.com/ck/a?u=a1${b64url}">Redirected Title</a></h2>
        <p class="b_lineclamp_1">Snippet.</p>
      </li>
    `
    const results = extractBingResults(html)
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://destination.com')
  })

  it('decodes HTML entities in titles and snippets', () => {
    const html = `
      <li class="b_algo">
        <h2><a href="https://example.com">O&rsquo;Reilly &amp; Co &mdash; Guide</a></h2>
        <p class="b_lineclamp_1">Learn &quot;everything&quot; about &lt;code&gt;</p>
      </li>
    `
    const results = extractBingResults(html)
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe(`O\u2019Reilly & Co \u2014 Guide`)
    expect(results[0].snippet).toBe('Learn "everything" about <code>')
  })

  // ─── Snippet extraction tiers ──────────────────────────────────────────

  it('extracts snippet from b_lineclamp (tier 1)', () => {
    const html = `
      <li class="b_algo">
        <h2><a href="https://example.com">Title</a></h2>
        <p class="b_lineclamp_1">Primary snippet text here.</p>
      </li>
    `
    const results = extractBingResults(html)
    expect(results[0].snippet).toBe('Primary snippet text here.')
  })

  it('falls back to b_caption > p (tier 2) when b_lineclamp missing', () => {
    const html = `
      <li class="b_algo">
        <h2><a href="https://example.com">Title</a></h2>
        <div class="b_caption">
          <p>Caption paragraph snippet.</p>
        </div>
      </li>
    `
    const results = extractBingResults(html)
    expect(results[0].snippet).toBe('Caption paragraph snippet.')
  })

  it('falls back to b_caption direct text (tier 3) when no inner p', () => {
    const html = `
      <li class="b_algo">
        <h2><a href="https://example.com">Title</a></h2>
        <div class="b_caption">Direct caption text.</div>
      </li>
    `
    const results = extractBingResults(html)
    expect(results[0].snippet).toBe('Direct caption text.')
  })

  it('snippet is undefined when none of the three tiers match', () => {
    const html = `
      <li class="b_algo">
        <h2><a href="https://example.com">Title</a></h2>
      </li>
    `
    const results = extractBingResults(html)
    expect(results).toHaveLength(1)
    expect(results[0].snippet).toBeUndefined()
  })

  // ─── Edge cases ────────────────────────────────────────────────────────

  it('skips relative and anchor links in results', () => {
    const html = `
      <li class="b_algo">
        <h2><a href="/local-page">Local</a></h2>
      </li>
      <li class="b_algo">
        <h2><a href="#section">Anchor</a></h2>
      </li>
      <li class="b_algo">
        <h2><a href="https://example.com">Valid</a></h2>
      </li>
    `
    const results = extractBingResults(html)
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://example.com')
  })

  it('strips HTML tags from titles', () => {
    const html = `
      <li class="b_algo">
        <h2><a href="https://example.com"><strong>Bold</strong> Title with <em>emphasis</em></a></h2>
        <p class="b_lineclamp_1">Snippet.</p>
      </li>
    `
    const results = extractBingResults(html)
    expect(results[0].title).toBe('Bold Title with emphasis')
  })

  it('handles real-world Bing HTML snippet (multiple b_algo attributes)', () => {
    const html = `
      <li class="b_algo" data-bm="12">
        <h2><a href="https://nodejs.org/en">Node.js &mdash; Run JavaScript Everywhere</a></h2>
        <div class="b_caption">
          <div class="b_attribution">
            <cite>nodejs.org</cite>
          </div>
          <p>Node.js is a free, open-source, cross-platform JavaScript runtime environment.</p>
        </div>
      </li>
    `
    const results = extractBingResults(html)
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe(`Node.js \u2014 Run JavaScript Everywhere`)
    expect(results[0].url).toBe('https://nodejs.org/en')
    expect(results[0].snippet).toBe(
      'Node.js is a free, open-source, cross-platform JavaScript runtime environment.',
    )
  })
})

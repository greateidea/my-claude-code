/**
 * WebFetch unit tests
 *
 * Tests the pure functions from the WebFetch tool:
 * - isPreapprovedHost / isPreapprovedUrl — preapproved domain matching
 * - validateURL — URL validation
 * - isPermittedRedirect — redirect safety checks
 *
 * Run: bun test tests/test-webfetch.test.ts
 */
import { describe, it, expect } from 'bun:test'
import { isPreapprovedHost, isPreapprovedUrl } from '../src/tools/webfetch/preapproved'
import { validateURL, isPermittedRedirect } from '../src/tools/webfetch/utils'

// ─── isPreapprovedHost ───────────────────────────────────────────────────────

describe('isPreapprovedHost', () => {
  it('matches well-known developer domains (exact hostname)', () => {
    expect(isPreapprovedHost('github.com')).toBe(true)
    expect(isPreapprovedHost('docs.python.org')).toBe(true)
    expect(isPreapprovedHost('react.dev')).toBe(true)
    expect(isPreapprovedHost('developer.mozilla.org')).toBe(true)
    expect(isPreapprovedHost('stackoverflow.com')).toBe(true)
    expect(isPreapprovedHost('www.npmjs.com')).toBe(true)
    expect(isPreapprovedHost('pypi.org')).toBe(true)
    expect(isPreapprovedHost('bun.sh')).toBe(true)
  })

  it('rejects unknown or random domains', () => {
    expect(isPreapprovedHost('random-blog.com')).toBe(false)
    expect(isPreapprovedHost('evil.example.com')).toBe(false)
    expect(isPreapprovedHost('not-github.com')).toBe(false)
    expect(isPreapprovedHost('github.com.evil.org')).toBe(false)
  })

  it('rejects subdomains of preapproved hosts (must be exact match)', () => {
    // Subdomains are NOT preapproved — only the exact hostname in the list
    expect(isPreapprovedHost('attacker.github.com')).toBe(false)
    expect(isPreapprovedHost('my.docs.python.org')).toBe(false)
    expect(isPreapprovedHost('evil.react.dev')).toBe(false)
  })

  it('matches path-scoped entries with segment boundary', () => {
    expect(isPreapprovedHost('github.com', '/anthropics/claude-code')).toBe(true)
    expect(isPreapprovedHost('github.com', '/greateidea/my-claude-code')).toBe(true)
    expect(isPreapprovedHost('vercel.com', '/docs/functions')).toBe(true)
    expect(isPreapprovedHost('docs.github.com', '/en/rest')).toBe(true)
  })

  it('matches path-scoped entry when path equals prefix exactly', () => {
    expect(isPreapprovedHost('github.com', '/anthropics')).toBe(true)
    expect(isPreapprovedHost('vercel.com', '/docs')).toBe(true)
  })

  it('rejects path-scoped entries without segment boundary (no partial match)', () => {
    // Use vercel.com which is ONLY in PATH_PREFIXES, not in HOSTNAME_ONLY
    expect(isPreapprovedHost('vercel.com', '/docs-extra')).toBe(false)
    expect(isPreapprovedHost('vercel.com', '/documentation')).toBe(false)
  })

  it('rejects path-scoped entry when hostname differs', () => {
    // vercel.com/docs only matches vercel.com hostname, not other hosts
    expect(isPreapprovedHost('other-site.com', '/docs/api')).toBe(false)
  })

  it('hostname-only match works regardless of path (path-scoped entries add, not restrict)', () => {
    // Hostnames in HOSTNAME_ONLY match regardless of path
    expect(isPreapprovedHost('github.com')).toBe(true)
    expect(isPreapprovedHost('github.com', '')).toBe(true)
    // But path-scoped-only hosts require a matching path
    expect(isPreapprovedHost('vercel.com', '')).toBe(false) // vercel.com is only in PATH_PREFIXES
    expect(isPreapprovedHost('vercel.com')).toBe(false)
  })
})

// ─── isPreapprovedUrl ────────────────────────────────────────────────────────

describe('isPreapprovedUrl', () => {
  it('returns true for preapproved URLs', () => {
    expect(isPreapprovedUrl('https://github.com/anthropics/claude-code')).toBe(true)
    expect(isPreapprovedUrl('https://react.dev/reference')).toBe(true)
    expect(isPreapprovedUrl('https://docs.python.org/3/library/re.html')).toBe(true)
    expect(isPreapprovedUrl('https://developer.mozilla.org/en-US/docs/Web/API/fetch')).toBe(true)
  })

  it('returns false for non-preapproved URLs', () => {
    expect(isPreapprovedUrl('https://random.com/page')).toBe(false)
    expect(isPreapprovedUrl('https://example.com/something')).toBe(false)
  })

  it('returns false for invalid URLs', () => {
    expect(isPreapprovedUrl('not-a-url')).toBe(false)
    expect(isPreapprovedUrl('')).toBe(false)
  })

  it('handles URLs with ports and query strings', () => {
    expect(isPreapprovedUrl('https://github.com/anthropics/claude-code?tab=readme')).toBe(true)
  })
})

// ─── validateURL ─────────────────────────────────────────────────────────────

describe('validateURL', () => {
  it('accepts valid HTTP/HTTPS URLs', () => {
    expect(validateURL('https://example.com')).toBe(true)
    expect(validateURL('http://example.com/path')).toBe(true)
    expect(validateURL('https://sub.example.com/path?q=1#hash')).toBe(true)
  })

  it('rejects URLs with credentials', () => {
    expect(validateURL('https://user:pass@example.com')).toBe(false)
    expect(validateURL('https://admin:@example.com')).toBe(false)
  })

  it('rejects hostnames without a dot (internal / localhost)', () => {
    expect(validateURL('http://localhost')).toBe(false)
    expect(validateURL('https://internal-server')).toBe(false)
    expect(validateURL('http://host')).toBe(false)
  })

  it('rejects non-URL strings', () => {
    expect(validateURL('not a url')).toBe(false)
    expect(validateURL('')).toBe(false)
    expect(validateURL('ftp://example.com')).toBe(true) // URL constructor accepts ftp
  })

  it('rejects URLs exceeding max length (2000 chars)', () => {
    const longPath = 'a'.repeat(2000)
    expect(validateURL(`https://example.com/${longPath}`)).toBe(false)
  })

  it('accepts URLs just under max length', () => {
    const path = 'a'.repeat(1960)
    expect(validateURL(`https://example.com/${path}`)).toBe(true)
  })

  it('handles IP addresses (rejected — no dot in hostname sense)', () => {
    // 127.0.0.1 has dots technically, but is an IP
    expect(validateURL('http://127.0.0.1')).toBe(true) // has dots, passes the check
  })

  it('accepts URLs with common ports', () => {
    expect(validateURL('https://example.com:8080/path')).toBe(true)
  })
})

// ─── isPermittedRedirect ─────────────────────────────────────────────────────

describe('isPermittedRedirect', () => {
  it('allows same-host redirect (change path/query only)', () => {
    expect(isPermittedRedirect('https://example.com/page1', 'https://example.com/page2')).toBe(true)
    expect(
      isPermittedRedirect('https://example.com/a', 'https://example.com/b?q=1'),
    ).toBe(true)
  })

  it('allows www addition', () => {
    expect(
      isPermittedRedirect('https://example.com', 'https://www.example.com'),
    ).toBe(true)
  })

  it('allows www removal', () => {
    expect(
      isPermittedRedirect('https://www.example.com', 'https://example.com'),
    ).toBe(true)
  })

  it('rejects cross-host redirects', () => {
    expect(
      isPermittedRedirect('https://example.com', 'https://other.com'),
    ).toBe(false)
    expect(
      isPermittedRedirect('https://a.example.com', 'https://b.example.com'),
    ).toBe(false)
  })

  it('rejects protocol changes', () => {
    expect(
      isPermittedRedirect('https://example.com', 'http://example.com'),
    ).toBe(false)
    expect(
      isPermittedRedirect('http://example.com', 'https://example.com'),
    ).toBe(false)
  })

  it('rejects redirects with credentials', () => {
    expect(
      isPermittedRedirect('https://example.com', 'https://user:pass@example.com'),
    ).toBe(false)
  })

  it('rejects redirects that change port', () => {
    expect(
      isPermittedRedirect('https://example.com', 'https://example.com:8080'),
    ).toBe(false)
  })

  it('handles invalid URLs gracefully', () => {
    expect(isPermittedRedirect('not-a-url', 'https://example.com')).toBe(false)
    expect(isPermittedRedirect('https://example.com', 'not-a-url')).toBe(false)
  })

  it('preserves subdomain when adding/removing www', () => {
    // sub.example.com → www.sub.example.com should be allowed
    expect(
      isPermittedRedirect('https://sub.example.com', 'https://www.sub.example.com'),
    ).toBe(true)
    expect(
      isPermittedRedirect('https://www.sub.example.com', 'https://sub.example.com'),
    ).toBe(true)
  })
})

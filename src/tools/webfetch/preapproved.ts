/**
 * Preapproved Hosts for WebFetch
 *
 * Domains that are considered safe and commonly used by developers.
 * Fetches from these domains are auto-approved without user confirmation.
 *
 * Trimmed from Claude Code's ~126 entry list to the most commonly used
 * developer domains. More can be added as needed.
 */

/** Host-only entries (exact hostname match) */
const HOSTNAME_ONLY = new Set([
  // Anthropic / AI
  'docs.anthropic.com',
  'claude.ai',
  'github.com',
  'raw.githubusercontent.com',
  'gitlab.com',
  'bitbucket.org',
  'stackoverflow.com',
  'stackexchange.com',
  'npmjs.com',
  'www.npmjs.com',
  'registry.npmjs.org',
  'yarnpkg.com',
  'crates.io',
  'pypi.org',
  'pub.dev',
  'docs.rs',

  // Programming languages
  'python.org',
  'docs.python.org',
  'nodejs.org',
  'go.dev',
  'pkg.go.dev',
  'rust-lang.org',
  'doc.rust-lang.org',
  'typescriptlang.org',
  'www.typescriptlang.org',
  'kotlinlang.org',
  'swift.org',
  'developer.apple.com',

  // Web frameworks
  'react.dev',
  'nextjs.org',
  'vuejs.org',
  'svelte.dev',
  'angular.io',
  'remix.run',
  'nuxt.com',
  'astro.build',
  'tailwindcss.com',
  'docusaurus.io',

  // Python frameworks
  'djangoproject.com',
  'docs.djangoproject.com',
  'flask.palletsprojects.com',
  'fastapi.tiangolo.com',

  // Databases
  'mongodb.com',
  'www.mongodb.com',
  'postgresql.org',
  'www.postgresql.org',
  'mysql.com',
  'dev.mysql.com',
  'redis.io',
  'sqlite.org',

  // Cloud / DevOps
  'aws.amazon.com',
  'docs.aws.amazon.com',
  'cloud.google.com',
  'azure.microsoft.com',
  'learn.microsoft.com',
  'kubernetes.io',
  'docker.com',
  'docs.docker.com',
  'terraform.io',
  'developer.hashicorp.com',

  // Data science / ML
  'tensorflow.org',
  'pytorch.org',
  'huggingface.co',
  'scikit-learn.org',
  'pandas.pydata.org',
  'numpy.org',

  // Testing / tooling
  'jestjs.io',
  'vitest.dev',
  'playwright.dev',
  'eslint.org',
  'prettier.io',
  'bun.sh',
  'webpack.js.org',
  'vitejs.dev',

  // Other useful docs
  'developer.mozilla.org',
  'en.wikipedia.org',
  'devdocs.io',
  'readthedocs.io',
  'npm.io',

  // Mobile
  'flutter.dev',
  'reactnative.dev',
  'developer.android.com',
])

/** Path-prefix entries (hostname match + path prefix match with segment boundary) */
const PATH_PREFIXES: Array<{ hostname: string; prefix: string }> = [
  { hostname: 'github.com', prefix: '/anthropics' },
  { hostname: 'github.com', prefix: '/greateidea' },
  { hostname: 'vercel.com', prefix: '/docs' },
  { hostname: 'docs.github.com', prefix: '/en' },
  { hostname: 'learn.microsoft.com', prefix: '/en-us' },
]

/**
 * Check if a hostname (with optional path) is in the preapproved list.
 *
 * For hostname-only entries: exact hostname match is required.
 * For path-prefix entries: hostname must match AND the path must start
 * with the prefix followed by "/" to ensure segment boundary (no partial match).
 */
export function isPreapprovedHost(hostname: string, pathname?: string): boolean {
  // Check exact hostname matches
  if (HOSTNAME_ONLY.has(hostname)) return true

  // Check path-scoped entries
  if (pathname) {
    for (const entry of PATH_PREFIXES) {
      if (
        hostname === entry.hostname &&
        (pathname === entry.prefix || pathname.startsWith(entry.prefix + '/'))
      ) {
        return true
      }
    }
  }

  return false
}

/** Convenience: check if a full URL is preapproved */
export function isPreapprovedUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return isPreapprovedHost(parsed.hostname, parsed.pathname)
  } catch {
    return false
  }
}

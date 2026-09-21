// This repository is public. Nothing that authenticates anything may be in it.
//
// The patterns are the shapes that actually leak: provider-prefixed tokens,
// private key blocks, and assignments to a name that says "secret". An
// example file is allowed and is meant to be committed.
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { report, REPO_ROOT, walk } from './lib.ts'

const SCANNED = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|json|md|ya?ml|sh|env)$/
const EXAMPLE = /\.example$|\.example\./

const PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['assigned secret', /\b(?:api[_-]?key|secret|passwd|password|token)\s*[:=]\s*['"][^'"\s{}$]{12,}['"]/i]
]

// The pattern list above is itself a file full of things that look like
// secrets. Scanning this file would fail the build on its own source.
const SELF = /scripts\/check-no-secrets\.ts$/

const problems: string[] = []
for (const file of await walk(REPO_ROOT, SCANNED)) {
  if (EXAMPLE.test(file) || SELF.test(file)) continue
  const lines = (await readFile(file, 'utf8')).split('\n')
  lines.forEach((line, index) => {
    for (const [what, pattern] of PATTERNS) {
      if (pattern.test(line)) problems.push(`${relative(REPO_ROOT, file)}:${String(index + 1)}: looks like a ${what}`)
    }
  })
}

report('check:secrets', problems)

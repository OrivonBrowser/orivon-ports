// What orivon.json grants, and that it grants what the backend and the page use and nothing they do
// not: https to the host the person types as their sync server (any host, since the host is theirs),
// the app's files with a quota larger than a budget plus the install tree, a Worker that may use
// synchronous file calls. No listener, no embedded page, no device.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ACTUAL_VERSION } from './plan.js'

const manifest = JSON.parse(readFileSync(new URL('../orivon.json', import.meta.url), 'utf8')) as {
  version: string
  crossOriginIsolated: boolean
  consentGranularity: string
  capabilities: { net?: Record<string, unknown>, fs?: { quotaBytes?: number }, web?: unknown, media?: unknown, devices?: unknown }
}

describe('the grants', () => {
  it('dials https to any host and port, and nothing else on the network', () => {
    expect(manifest.capabilities.net).toEqual({ https: { connect: ['*:*'] } })
  })

  it('declares no listener, embedded page, device or media', () => {
    expect(Object.keys(manifest.capabilities).sort()).toEqual(['fs', 'net'])
  })

  it('keeps the budgets and the install tree in the app\'s files, with a quota larger than both', () => {
    expect(manifest.capabilities.fs?.quotaBytes).toBeGreaterThanOrEqual(256 * 1024 * 1024)
  })

  it('is cross-origin isolated, which the Worker\'s synchronous file access needs, and asks once for everything', () => {
    expect(manifest.crossOriginIsolated).toBe(true)
    expect(manifest.consentGranularity).toBe('all-or-nothing')
  })

  it('is versioned as the release the bridge answers for', () => {
    expect(manifest.version.startsWith(ACTUAL_VERSION)).toBe(true)
  })
})

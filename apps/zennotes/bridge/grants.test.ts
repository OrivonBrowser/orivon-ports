// What orivon.json asks the person to grant: a private folder for the app's own files, and nothing
// else. The notes folder is not a grant: the person picks it in Orivon's own folder dialog, and the
// app is given that one folder and nothing around it. The settings, themes and undo history are the
// app's own files, and the network is not declared because no part of the notes path needs it.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../orivon.json', import.meta.url), 'utf8')) as {
  capabilities: Record<string, unknown>
  consentGranularity: string
  version: string
  domain: string
}
const recipe = JSON.parse(readFileSync(new URL('../recipe.json', import.meta.url), 'utf8')) as { upstream: { ref: string }, eth: string }

describe('the grants', () => {
  it('asks for the app\'s own files and nothing else', () => {
    expect(Object.keys(manifest.capabilities)).toEqual(['fs'])
  })

  it('caps the app\'s own files, so undo history cannot fill the disk', () => {
    const { quotaBytes } = manifest.capabilities['fs'] as { quotaBytes: number }
    expect(quotaBytes).toBeGreaterThan(0)
    expect(quotaBytes).toBeLessThanOrEqual(256 * 1024 * 1024)
  })

  it('declares no network, no listener, no device and no web context', () => {
    for (const kind of ['net', 'web', 'devices', 'media', 'secrets', 'id']) expect(manifest.capabilities[kind], kind).toBeUndefined()
  })

  it('asks once for all of it, because the app never knew Orivon', () => {
    expect(manifest.consentGranularity).toBe('all-or-nothing')
  })

  it('is addressed where the recipe serves it in development, and versioned as the release it builds', () => {
    expect(manifest.domain).toBe(recipe.eth)
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(\.\d+)?$/)
  })
})

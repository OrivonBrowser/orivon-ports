// What orivon.json grants, and that it grants what the launcher uses and nothing it does not: a loopback
// listener on the one port the launcher gives the server, the shown page under that port's local pattern,
// the app's files. No network is dialled, because the wiki server dials nothing.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PORT } from '../launcher/plan.js'

const manifest = JSON.parse(readFileSync(new URL('../orivon.json', import.meta.url), 'utf8')) as {
  crossOriginIsolated: boolean
  consentGranularity: string
  capabilities: { net?: { tcp?: { listen?: { local?: string[] }, connect?: string[] }, https?: unknown, udp?: unknown }, fs?: { quotaBytes?: number }, web?: { embed?: { origins?: string[] } } }
}

describe('the grants', () => {
  it('listens on the loopback port the launcher starts the server on, and only that one', () => {
    expect(manifest.capabilities.net?.tcp?.listen?.local).toEqual([String(PORT)])
  })

  it('shows the server\'s page under the local pattern for that port, and no other origin', () => {
    expect(manifest.capabilities.web?.embed?.origins).toEqual([`http://*.localhost:${String(PORT)}`])
  })

  it('declares no outgoing network of any kind', () => {
    const net = manifest.capabilities.net ?? {}
    expect(net.tcp?.connect).toBeUndefined()
    expect(net.https).toBeUndefined()
    expect(net.udp).toBeUndefined()
    expect(Object.keys(net)).toEqual(['tcp'])
    expect(Object.keys(net.tcp ?? {})).toEqual(['listen'])
  })

  it('keeps the wiki and the install tree in the app\'s files, with a quota larger than the tree', () => {
    expect(manifest.capabilities.fs?.quotaBytes).toBeGreaterThan(64 * 1024 * 1024)
  })

  it('is cross-origin isolated, which the Worker\'s synchronous file access needs, and asks once for everything', () => {
    expect(manifest.crossOriginIsolated).toBe(true)
    expect(manifest.consentGranularity).toBe('all-or-nothing')
  })
})

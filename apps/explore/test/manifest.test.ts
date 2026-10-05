import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { contains, diffCapabilities, mergeDeclarations } from '../site/lab/declarations.js'
import { PROBES } from '../site/lab/probes.js'
import { canRequest, canRun, probeState } from '../site/lab/state.js'

const manifest = JSON.parse(await readFile(new URL('../orivon.json', import.meta.url), 'utf8')) as {
  consentGranularity: string
  capabilities: Record<string, unknown>
}

// The directory's own question: one capability, so a visitor meets one dialog about the
// Web3 Score provider and nothing else.
const DIRECTORY = { trust: { score: true } }
const expected = () => mergeDeclarations([...PROBES, { declares: DIRECTORY }])

describe('the manifest and the probes', () => {
  it('declares exactly what the registered probes declare, plus the directory\'s own capability', () => {
    expect(diffCapabilities(expected(), manifest.capabilities)).toEqual([])
    expect(manifest.capabilities, 'a probe now needs a capability, or the manifest declares one the directory does not use: move the Lab to its own origin first (README, Design notes)').toEqual(expected())
  })

  // Grants attach to the origin, so a probe that needs a capability would put a second
  // consent question in front of everyone who only wants to browse the directory. The
  // README's Design notes say where the Lab goes when that day comes.
  it('keeps the directory\'s own capability to trust.score, with no probe adding another', () => {
    expect(mergeDeclarations(PROBES), 'a probe now needs a capability: move the Lab to its own origin first (README, Design notes)').toEqual({})
    expect(manifest.capabilities).toEqual(DIRECTORY)
  })

  it('asks for consent per capability, so a probe can request its own', () => {
    expect(manifest.consentGranularity).toBe('per-capability')
  })

  it('has probes with unique ids that say what they need', () => {
    const ids = PROBES.map((probe) => probe.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const probe of PROBES) {
      expect(probe.title.length).toBeGreaterThan(0)
      expect(probe.capability === null || typeof probe.capability === 'string').toBe(true)
    }
  })

  // The comparison has to be able to fail, or the test above proves nothing.
  it('notices a probe that declares more than the manifest does', () => {
    const extra = { id: 'extra', title: 't', capability: 'https.connect', declares: { net: { https: { connect: ['a.example'] } } }, run: () => Promise.resolve({ ok: true, detail: '' }) }
    expect(diffCapabilities(mergeDeclarations([...PROBES, { declares: DIRECTORY }, extra]), manifest.capabilities)).not.toEqual([])
  })

  it('notices a manifest that declares more than the probes need', () => {
    expect(diffCapabilities({}, { fs: {} })).not.toEqual([])
  })
})

describe('declarations', () => {
  it('merges objects deeply and unions arrays', () => {
    const merged = mergeDeclarations([
      { declares: { net: { https: { connect: ['a'] } } } },
      { declares: { net: { https: { connect: ['a', 'b'] }, tcp: { connect: ['c'] } } } }
    ])
    expect(merged).toEqual({ net: { https: { connect: ['a', 'b'] }, tcp: { connect: ['c'] } } })
  })

  it('checks containment of keys and of array elements', () => {
    expect(contains({ a: { b: [1, 2] }, c: 1 }, { a: { b: [2] } })).toBe(true)
    expect(contains({ a: { b: [1] } }, { a: { b: [2] } })).toBe(false)
    expect(contains({}, { a: {} })).toBe(false)
    expect(contains({ a: 1 }, {})).toBe(true)
  })
})

describe('probe state', () => {
  const needing = { capability: 'https.connect', declares: { net: { https: { connect: ['a'] } } } }
  const free = { capability: null, declares: {} }
  const view = (over: Record<string, unknown>) => ({ inOrivon: true, version: 0, registered: true, manifest: { id: 'x', version: '1', capabilities: {} }, grants: [], notes: [], ...over }) as Parameters<typeof probeState>[1]

  it('walks from not in Orivon to granted', () => {
    expect(probeState(free, view({ inOrivon: false }))).toBe('not in Orivon')
    expect(probeState(free, view({}))).toBe('ready')
    expect(probeState(needing, view({}))).toBe('not declared')
    const declared = { id: 'x', version: '1', capabilities: needing.declares }
    expect(probeState(needing, view({ manifest: declared }))).toBe('declared, not granted')
    expect(probeState(needing, view({ manifest: declared, grants: [{ capability: 'https.connect' }] }))).toBe('granted')
    expect(probeState(needing, view({ manifest: null }))).toBe('not declared')
  })

  it('lets a probe run when ready or granted, and request only when declared and not granted', () => {
    expect(canRun('ready') && canRun('granted')).toBe(true)
    expect(canRun('not declared') || canRun('not in Orivon') || canRun('declared, not granted')).toBe(false)
    expect(canRequest('declared, not granted')).toBe(true)
    expect(canRequest('granted')).toBe(false)
  })
})

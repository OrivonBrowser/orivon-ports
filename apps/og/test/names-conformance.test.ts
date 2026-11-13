import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CENSUS_FORMAT } from '../site/resolver/og-census.js'
import { IMPLEMENTATION, UPGRADES } from '../site/resolver/og-pins.js'
import { fakeOrivon } from './support/fake-orivon.ts'
import { NAMES_0_1, NAMES_0_2, runVectors } from './support/names-vectors.ts'
import type { NamesStandard } from './support/names-vectors.ts'

const manifest = JSON.parse(await readFile(new URL('../orivon.json', import.meta.url), 'utf8'))
const STANDARDS = [NAMES_0_1, NAMES_0_2]
const NO_GRANT = ['ETH_NET_0_1_READONLY', 'ETH_0_1', 'ETH_NET_0_1']
const CENSUS = { format: CENSUS_FORMAT, block: 26_400_700, blockHash: `0x${'00'.repeat(32)}`, implementation: IMPLEMENTATION, upgrades: [...UPGRADES], names: {} }
const declared = (): string[] => manifest.integrations[0].codes

type Implementation = Record<string, (context: unknown, ...args: any[]) => Promise<any>>

// An install starts the page over the bundle it pinned, with no network and no grant, and runs each declared code's vectors through the
// functions the page provided. Here the same functions are called with the call context the browser hands a page, over a `use` that
// is granted nothing.
describe('the vectors an install runs against the page, for each code the declaration lists', () => {
  const provided: Record<string, Implementation> = {}
  let censusStatus: number

  async function start () {
    vi.resetModules()
    for (const key of Object.keys(provided)) delete provided[key]
    const provide = vi.fn((code: string, implementation: Implementation) => {
      if (!Object.hasOwn(provided, code) && declared().includes(code)) provided[code] = implementation
      else throw Object.assign(new Error(`${code} is not a code this integration provides`), { code: 'invalid' })
    })
    ;(globalThis as any).window = { orivonIntegration: { version: 0, provide, use: async () => { throw Object.assign(new Error('no grant'), { code: 'denied' }) } } }
    await import('../site/resolver/resolver.js')
    return provide
  }
  /** The way an install reaches a code: the call goes to the function the page provided, under the standard's own deadline. */
  function invokeFor (standard: NamesStandard, orivon: ReturnType<typeof fakeOrivon>) {
    return async (fn: string, args: readonly unknown[]) => {
      const implementation = provided[standard.code]?.[fn]
      if (implementation === undefined) throw Object.assign(new Error(`${standard.code}.${fn} is not provided`), { code: 'unavailable' })
      const context = { depth: 1, deadlineAt: Date.now() + (standard.functions[fn]?.deadlineMs ?? 10_000), signal: new AbortController().signal, use: orivon.orivon.use, progress: vi.fn() }
      return await implementation(context, ...args)
    }
  }

  beforeEach(() => {
    censusStatus = 200
    vi.stubGlobal('fetch', async () => new Response(censusStatus === 200 ? JSON.stringify(CENSUS) : '', { status: censusStatus }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    delete (globalThis as any).window
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('lists NAMES_0_1 and NAMES_0_2, the two codes the page provides', async () => {
    expect(declared()).toEqual(['NAMES_0_1', 'NAMES_0_2'])
    const provide = await start()
    expect(provide.mock.calls.map((call) => call[0])).toEqual(declared())
  })

  it('provides, for each code, exactly the functions its module defines: the browser refuses one that lacks a function or adds one', async () => {
    await start()
    for (const standard of STANDARDS) expect(Object.keys(provided[standard.code]!), standard.code).toEqual(Object.keys(standard.functions))
  })

  it('passes the vectors of each standard, setRecord included, without reading Ethereum or asking for a grant', async () => {
    await start()
    const orivon = fakeOrivon({}, NO_GRANT)
    const reports = []
    for (const standard of STANDARDS) reports.push(await runVectors(standard, invokeFor(standard, orivon)))
    expect(reports.map((report) => report.failed)).toEqual([[], []])
    expect(reports.map(({ passed, ran, skipped }) => ({ passed, ran, skipped }))).toEqual([{ passed: 1, ran: 1, skipped: 1 }, { passed: 6, ran: 6, skipped: 1 }])
    expect(orivon.uses).toEqual([])
    expect(orivon.calls).toEqual([])
  })

  it('refuses a name outside .og as invalid even when the census could not be read', async () => {
    censusStatus = 404
    await start()
    const orivon = fakeOrivon({}, NO_GRANT)
    for (const standard of STANDARDS) expect((await runVectors(standard, invokeFor(standard, orivon))).failed, standard.code).toEqual([])
  })

  it('leaves out the live vector, which no .og resolver answers: a .eth name is invalid here', async () => {
    await start()
    const orivon = fakeOrivon({}, NO_GRANT)
    for (const standard of STANDARDS) {
      expect(standard.vectors.filter((vector) => vector.live === true).map((vector) => vector.args)).toEqual([['vitalik.eth']])
      await expect(invokeFor(standard, orivon)('resolve', ['vitalik.eth'])).rejects.toMatchObject({ code: 'invalid' })
    }
  })

  it('fails a vector that is answered where the standard says invalid, so a page that answered everything would not pass', async () => {
    const answering = async () => ({ ownerDefault: null, records: [], provenance: { by: 'x', proven: false } })
    const report = await runVectors(NAMES_0_2, answering)
    expect(report.failed.map((failure) => failure.fn)).toEqual(['resolve', 'setRecord', 'setRecord', 'setRecord', 'setRecord', 'setRecord'])
  })
})

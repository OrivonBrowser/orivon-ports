import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Orivon installs a tab's Node globals fail-open, so a tab that runs as the app can hold its grants and lack `process`.
// A first visit's tab is a website, with no grants yet. `orivon.app.grants()` tells the two apart. When Orivon cannot install its
// full surface it exposes a fail-closed `window.orivon` instead, with no `net.connect` and a `grants()` that refuses.
const mem = vi.hoisted(() => ({ settings: new Map<string, unknown>() }))
vi.mock('../page/src/store.js', () => ({
  getSetting: async (key: string, fallback: unknown) => mem.settings.has(key) ? mem.settings.get(key) : fallback,
  setSetting: async (key: string, value: unknown) => { mem.settings.set(key, value) },
  listHosted: async () => []
}))

const { createHosting } = await import('../page/src/publish/hosting.js')

const grant = { id: 'g', origin: 'https://editor', capability: 'tcp.connect', patterns: ['*:*'], grantedAt: 1 }
const surface = (grants: () => Promise<unknown>) => ({ net: { connect () {}, listen () {}, lookup () {} }, app: { grants } })
const letIn = () => vi.stubGlobal('window', { orivon: surface(async () => [grant]) })
const LINE = '[decentrawiki] hosting could not start the IPFS node: Orivon let the editor in, but this tab loaded without the Node globals the node starts through'

type Spy = { mock: { calls: unknown[][] }, mockClear: () => void, mockRestore: () => void }
let errors: Spy
const errorLines = () => errors.mock.calls.map((call) => String(call[0]))
const launcher = { start: vi.fn(), find: vi.fn(async () => null) }
const hosting = (more: Record<string, unknown> = {}) => createHosting({ launcher: async () => launcher as never, settleMs: 0, pollMs: 0, ...more })

beforeEach(() => {
  mem.settings.clear()
  launcher.start.mockClear()
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errors.mockRestore()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('when Orivon has let the editor in but this tab has no Node globals', () => {
  it('writes one failure line, starts no node, and tells Settings', async () => {
    const made = hosting()
    letIn()
    await made.resume()
    await made.resume()
    expect(errorLines()).toEqual([LINE])
    expect(await made.blocked()).toBe('globals')
    expect(errorLines()).toEqual([LINE])
    expect(launcher.start).not.toHaveBeenCalled()
    expect(await made.node()).toBeNull()
  })

  it('waits before writing the line, because Allow replaces a first visit\'s page with the app\'s', async () => {
    vi.useFakeTimers()
    const made = hosting({ settleMs: undefined })
    letIn()
    const resumed = made.resume()
    await vi.advanceTimersByTimeAsync(1000)
    expect(errorLines()).toEqual([])
    await vi.advanceTimersByTimeAsync(5000)
    await resumed
    expect(errorLines()).toEqual([LINE])
  })

  it('writes no line when the person turned hosting off, though Settings is still told', async () => {
    const made = hosting()
    mem.settings.set('hostWikis', false)
    letIn()
    await made.resume()
    expect(await made.blocked()).toBe('globals')
    expect(errorLines()).toEqual([])
  })

  it('is not a first visit\'s tab only when a network grant is held: not with none, a refused call, another grant, no app member, or the globals there', async () => {
    const made = hosting()
    for (const grants of [async () => [], async () => [{ ...grant, capability: 'https.connect' }], async () => { throw new Error('denied') }]) {
      vi.stubGlobal('window', { orivon: surface(grants) })
      await made.resume()
      expect(await made.blocked()).toBeNull()
    }
    vi.stubGlobal('window', { orivon: { net: { connect () {}, listen () {} } } })
    expect(await made.blocked()).toBeNull()
    vi.stubGlobal('window', { orivon: surface(async () => [grant]), process: {} })
    expect(await made.blocked()).toBeNull()
    expect(errorLines()).toEqual([])
  })
})

describe('when Orivon exposed its fail-closed window.orivon, with no net.connect', () => {
  const NETWORK_LINE = '[decentrawiki] hosting could not start the IPFS node: Orivon did not give this tab the network access the node needs (window.orivon has no net.connect)'
  const refuse = async () => { throw new Error('orivon: refused -- this surface has no caller-attribution filter') }
  const failClosed = () => vi.stubGlobal('window', { orivon: { version: 0, app: { grants: refuse }, net: { lookup: refuse } } })

  it('writes one failure line, starts no node, and tells Settings', async () => {
    const made = hosting()
    failClosed()
    await made.resume()
    await made.resume()
    expect(errorLines()).toEqual([NETWORK_LINE])
    expect(await made.blocked()).toBe('network')
    expect(errorLines()).toEqual([NETWORK_LINE])
    expect(launcher.start).not.toHaveBeenCalled()
    expect(await made.node()).toBeNull()
  })

  it('waits before writing the line, and writes none when the person turned hosting off', async () => {
    vi.useFakeTimers()
    const made = hosting({ settleMs: undefined })
    failClosed()
    const resumed = made.resume()
    await vi.advanceTimersByTimeAsync(1000)
    expect(errorLines()).toEqual([])
    await vi.advanceTimersByTimeAsync(5000)
    await resumed
    expect(errorLines()).toEqual([NETWORK_LINE])
    vi.useRealTimers()
    errors.mockClear()
    mem.settings.set('hostWikis', false)
    const off = hosting()
    await off.resume()
    expect(await off.blocked()).toBe('network')
    expect(errorLines()).toEqual([])
  })

  it('is not the tab of a page in another browser or of a first visit\'s website: neither holds such a surface, and neither writes a line', async () => {
    const made = hosting()
    for (const page of [{}, { orivon: undefined }, { orivon: null }, { orivon: true }, { orivon: surface(async () => []) }]) {
      vi.stubGlobal('window', page)
      await made.resume()
      expect(await made.blocked()).toBeNull()
    }
    expect(errorLines()).toEqual([])
  })
})

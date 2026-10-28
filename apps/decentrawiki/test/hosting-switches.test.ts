import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeElement, installFakeDom, removeFakeDom } from './fake-dom.ts'

beforeAll(installFakeDom)
afterAll(removeFakeDom)

const mem = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  stored: 0,
  /** What the mocked hosting was asked, and what it reports. */
  stops: 0,
  resumes: 0,
  nodeUp: true,
  summary: { running: false, wikis: 0, announced: 0, state: 'off' as 'off' | 'starting' | 'announced' | 'unreachable', reachability: 'unknown', relays: 0 }
}))

vi.mock('../page/src/store.js', () => ({
  getSetting: async (key: string, fallback: unknown) => mem.settings.has(key) ? mem.settings.get(key) : fallback,
  setSetting: async (key: string, value: unknown) => { mem.settings.set(key, value) },
  listHosted: async () => Array.from({ length: mem.stored }, (_, i) => ({ wiki: `w${String(i)}` }))
}))

vi.mock('../page/src/publish/hosting.js', () => {
  const listening = () => typeof (globalThis as { window?: { orivon?: { net?: { listen?: unknown } } } }).window?.orivon?.net?.listen === 'function'
  return {
    hostingAvailable: listening,
    hosting: {
      enabled: async () => listening() && mem.settings.get('hostWikis') !== false,
      node: async () => mem.nodeUp ? { base: 'http://127.0.0.1:5180', key: 'k', peer: 'p', port: 5180 } : null,
      poll: async () => true,
      resume: async () => { mem.resumes++ },
      stop: async () => { mem.stops++ },
      summary: () => mem.summary
    }
  }
})

vi.mock('../page/src/views/addresses.js', () => ({ addressesPanel: async () => document.createElement('div') }))
vi.mock('../page/src/ui/dialog.js', () => ({ confirmDialog: async () => true, downloadFile: () => {}, openDialog: () => ({}), toast: () => {} }))

const { hostingStatus, hostingSwitches } = await import('../page/src/views/hosting-switches.js')
const { renderSettings } = await import('../page/src/views/settings.js')

const STOPS = 'It stops when you close the editor\'s last tab.'
const summary = (more: Partial<typeof mem.summary> = {}) => ({ ...mem.summary, ...more })
const boxes = (view: unknown) => (view as FakeElement).all('input').filter((input) => input.attrs['type'] === 'checkbox')
const inOrivon = () => vi.stubGlobal('window', { orivon: { net: { connect () {}, listen () {} } } })

beforeEach(() => {
  mem.settings.clear()
  mem.stored = 0
  mem.stops = 0
  mem.resumes = 0
  mem.nodeUp = true
  mem.summary = { running: false, wikis: 0, announced: 0, state: 'off', reachability: 'unknown', relays: 0 }
})
afterEach(() => { vi.unstubAllGlobals() })

describe('the hosting status line', () => {
  it('says off, and nothing about the editor\'s last tab, when hosting is off', () => {
    expect(hostingStatus(false, summary())).toBe('Off.')
  })

  it('says what a person needs to do before a wiki is hosted, and that the node is starting once wikis are stored', () => {
    expect(hostingStatus(true, summary())).toContain('Nothing is hosted yet')
    expect(hostingStatus(true, summary())).toContain('Publish again to host one published before.')
    expect(hostingStatus(true, summary(), { stored: 2 })).toBe(`Starting… ${STOPS}`)
    expect(hostingStatus(true, summary({ wikis: 2, state: 'starting' }))).toBe(`Starting… ${STOPS}`)
    expect(hostingStatus(true, summary(), { stored: 2, failed: true })).toContain('did not start')
  })

  it('says how the wikis are reached, and when they cannot be', () => {
    const hosted = { running: true, wikis: 3, announced: 3, state: 'announced' as const }
    expect(hostingStatus(true, summary({ ...hosted, reachability: 'public' }))).toBe(`Hosting 3 wikis, reachable directly. ${STOPS}`)
    expect(hostingStatus(true, summary({ ...hosted, wikis: 1, announced: 1, reachability: 'private', relays: 1 }))).toBe(`Hosting 1 wiki, through Orivon's relay. ${STOPS}`)
    expect(hostingStatus(true, summary({ ...hosted, reachability: 'unknown' }))).toBe(`Hosting 3 wikis, announced on IPFS. ${STOPS}`)
    expect(hostingStatus(true, summary({ ...hosted, announced: 0, state: 'unreachable', reachability: 'private' }))).toBe(`Not reachable: your router refuses connections and Orivon's relay could not be reached. ${STOPS}`)
  })
})

describe('the two switches', () => {
  it('show hosting off and disabled outside Orivon, and free pinning on', async () => {
    const view = await hostingSwitches(() => {})
    expect(boxes(view).map((box) => [box.checked, box.hasAttribute('disabled')])).toEqual([[false, true], [true, false]])
    const text = (view as unknown as FakeElement).textContent
    expect(text).toContain('Needs Orivon: other browsers give a page no IPFS node.')
    expect(text).toContain('The wiki is uploaded to Orivon\'s server')
    expect(text).toContain('IP address')
  })

  it('say Orivon has not allowed listening when the editor has sockets but cannot accept connections', async () => {
    vi.stubGlobal('window', { orivon: { net: { connect () {} } } })
    const view = await hostingSwitches(() => {})
    expect(boxes(view)[0]?.hasAttribute('disabled')).toBe(true)
    expect((view as unknown as FakeElement).textContent).toContain('Orivon has not allowed this editor to accept connections from the network')
  })

  it('are both on in Orivon until turned off, and say what Orivon\'s server does with the wiki', async () => {
    inOrivon()
    const view = await hostingSwitches(() => {})
    expect(boxes(view).map((box) => box.checked)).toEqual([true, true])
    const text = (view as unknown as FakeElement).textContent
    expect(text).toContain('Host your wikis from this computer')
    expect(text).toContain('serves the newest version of every wiki you publish to anyone on IPFS, while the editor is open')
    expect(text).toContain('Orivon\'s server fetches each new version from your computer over IPFS, keeps it for 30 days')
    expect(text).toContain('Nothing is hosted yet')
  })

  it('save the hosting switch, end the node when it is turned off, and give the node the stored wikis when it is turned on', async () => {
    inOrivon()
    let drawn = 0
    const view = await hostingSwitches(() => { drawn++ })
    const [hosting] = boxes(view) as FakeElement[]
    hosting!.checked = false
    hosting!.fire('change')
    await vi.waitFor(() => expect(drawn).toBe(1))
    expect(mem.settings.get('hostWikis')).toBe(false)
    expect(mem.stops).toBe(1)
    hosting!.checked = true
    hosting!.fire('change')
    await vi.waitFor(() => expect(drawn).toBe(2))
    expect(mem.settings.get('hostWikis')).toBe(true)
    expect(mem.resumes).toBe(1)
  })

  it('save the free pinning switch, and say what stays when it is off', async () => {
    inOrivon()
    let drawn = 0
    const view = await hostingSwitches(() => { drawn++ })
    const free = boxes(view)[1] as FakeElement
    free.checked = false
    free.fire('change')
    await vi.waitFor(() => expect(drawn).toBe(1))
    expect(mem.settings.get('freePinning')).toBe(false)
    const off = await hostingSwitches(() => {})
    expect(boxes(off).map((box) => box.checked)).toEqual([true, false])
    expect((off as unknown as FakeElement).textContent).toContain('Orivon\'s server still keeps the IPNS address of a wiki you publish under one')
  })

  it('show a node that did not start for stored wikis, and one that is starting', async () => {
    inOrivon()
    mem.stored = 2
    mem.nodeUp = false
    const failed = await hostingSwitches(() => {})
    await vi.waitFor(() => expect((failed as unknown as FakeElement).textContent).toContain('The IPFS node did not start'))
    mem.nodeUp = true
    const starting = await hostingSwitches(() => {})
    await vi.waitFor(() => expect((starting as unknown as FakeElement).textContent).toContain('Starting…'))
  })
})

describe('Settings, with the two switches in it', () => {
  const settingsView = () => new FakeElement('div')

  it('speaks of the route Publish takes by default', async () => {
    const outside = settingsView()
    await renderSettings(outside as never)
    expect(outside.textContent).toContain('Host your wikis from this computer')
    expect(outside.textContent).toContain('Publish uses free pinning by Orivon, or downloads a wiki as a CAR file')

    inOrivon()
    const inside = settingsView()
    await renderSettings(inside as never)
    expect(inside.textContent).toContain('Publish uses your IPFS node, in this page, which Orivon keeps up for 30 days')
    expect(inside.textContent).toContain('Hosting: this page runs an IPFS node')
    expect(inside.textContent).toContain('Free pinning: Orivon\'s node connects to your node')
  })

  it('speaks of only this computer when free pinning is off, and of a download when both are', async () => {
    inOrivon()
    mem.settings.set('freePinning', false)
    const hostedOnly = settingsView()
    await renderSettings(hostedOnly as never)
    expect(hostedOnly.textContent).toContain('Publish uses only this computer, while the editor is open, or downloads')
    expect(hostedOnly.textContent).not.toContain('Free pinning: Orivon\'s node')

    mem.settings.set('hostWikis', false)
    const neither = settingsView()
    await renderSettings(neither as never)
    expect(neither.textContent).toContain('No service of yours yet. Publish downloads a wiki as a CAR file for you to pin anywhere.')
    expect(neither.textContent).not.toContain('Hosting: this page runs an IPFS node')
  })
})

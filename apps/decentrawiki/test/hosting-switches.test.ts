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
  nodeCalls: 0,
  nodeUp: true,
  lingering: null as 'here' | 'elsewhere' | null,
  summary: { running: false, wikis: 0, announced: 0, unplaced: 0, state: 'off' as 'off' | 'starting' | 'announced' | 'unreachable', reachability: 'unknown', relays: 0 }
}))

vi.mock('../page/src/store.js', () => ({
  getSetting: async (key: string, fallback: unknown) => mem.settings.has(key) ? mem.settings.get(key) : fallback,
  setSetting: async (key: string, value: unknown) => { mem.settings.set(key, value) },
  listHosted: async () => Array.from({ length: mem.stored }, (_, i) => ({ wiki: `w${String(i)}` }))
}))

vi.mock('../page/src/publish/hosting.js', async () => {
  // The availability rule, `enabled` and the tab check are the real ones, so a change to them reaches these cases.
  const actual = await vi.importActual<typeof import('../page/src/publish/hosting.js')>('../page/src/publish/hosting.js')
  return {
    hostingAvailable: actual.hostingAvailable,
    hosting: {
      enabled: actual.hosting.enabled,
      blocked: actual.hosting.blocked,
      // Starting the node places nothing on it; resume starts it and gives it the stored wikis.
      node: async () => {
        mem.nodeCalls++
        mem.summary = { ...mem.summary, running: mem.nodeUp }
        return mem.nodeUp ? { base: 'http://127.0.0.1:5180', key: 'k', peer: 'p', port: 5180 } : null
      },
      poll: async () => true,
      resume: async () => {
        mem.resumes++
        mem.summary = mem.nodeUp ? { ...mem.summary, running: true, wikis: mem.stored, announced: mem.stored, state: 'announced', reachability: 'public' } : { ...mem.summary, running: false }
      },
      stop: async () => { mem.stops++ },
      lingers: async () => mem.lingering,
      summary: () => mem.summary
    }
  }
})

vi.mock('../page/src/views/addresses.js', () => ({ addressesPanel: async () => (globalThis as unknown as { document: { createElement: (tag: string) => unknown } }).document.createElement('div') }))
vi.mock('../page/src/ui/dialog.js', () => ({ confirmDialog: async () => true, downloadFile: () => {}, openDialog: () => ({}), toast: () => {} }))

const { hostingStatus, hostingSwitches } = await import('../page/src/views/hosting-switches.js')
const { renderSettings } = await import('../page/src/views/settings.js')

const STOPS = 'It stops when you close the editor\'s last tab.'
const summary = (more: Partial<typeof mem.summary> = {}) => ({ ...mem.summary, ...more })
const boxes = (view: unknown) => (view as FakeElement).all('input').filter((input) => input.attrs['type'] === 'checkbox')
const inOrivon = () => vi.stubGlobal('window', { orivon: { net: { connect () {}, listen () {} } }, process: {} })

beforeEach(() => {
  mem.settings.clear()
  mem.stored = 0
  mem.stops = 0
  mem.resumes = 0
  mem.nodeCalls = 0
  mem.nodeUp = true
  mem.lingering = null
  mem.summary = { running: false, wikis: 0, announced: 0, unplaced: 0, state: 'off', reachability: 'unknown', relays: 0 }
})
afterEach(() => { vi.unstubAllGlobals() })

describe('the hosting status line', () => {
  it('says off, and nothing about the editor\'s last tab, when hosting is off and no node is left', () => {
    expect(hostingStatus(false, summary())).toBe('Off.')
  })

  it('says a node another tab or an earlier load started keeps running and listening when hosting is off, until the editor\'s last tab closes', () => {
    const line = hostingStatus(false, summary(), { lingers: 'elsewhere' })
    expect(line).toContain('Off: your wikis are no longer announced')
    expect(line).toContain('another tab or an earlier load of the editor started is still running and listening')
    expect(line).toContain('this computer stays on the IPFS network until you close the editor\'s last tab')
  })

  it('says the node is this tab\'s own, and that turning hosting on and off here ends it, when another tab turned hosting off', () => {
    const line = hostingStatus(false, summary(), { lingers: 'here' })
    expect(line).toContain('the IPFS node that this tab started is still running and listening')
    expect(line).toContain('until you turn hosting on and off again here, or close the editor\'s last tab')
    expect(line).not.toContain('another tab')
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

  it('says a computer behind a router with no place on the relay is not reachable, though the node announced the wikis over its own connections', () => {
    const announced = { running: true, wikis: 1, announced: 1, state: 'announced' as const, reachability: 'private', relays: 0 }
    expect(hostingStatus(true, summary(announced))).toBe(`Not reachable: your router refuses connections and Orivon's relay could not be reached. ${STOPS}`)
    expect(hostingStatus(true, summary(announced), { stored: 1 })).not.toContain('announced on IPFS')
  })

  it('says when the node would not take wikis, instead of starting for ever, and how many it left out of those it hosts', () => {
    const full = 'it may be full. Close the editor\'s other tabs and reload the editor to try again.'
    expect(hostingStatus(true, summary({ running: true, unplaced: 1 }), { stored: 1 })).toBe(`The IPFS node would not take a wiki: ${full}`)
    expect(hostingStatus(true, summary({ running: true, unplaced: 3 }), { stored: 3 })).toBe(`The IPFS node would not take 3 wikis: ${full}`)
    expect(hostingStatus(true, summary({ running: true, wikis: 2, announced: 2, unplaced: 1, state: 'announced', reachability: 'public' }), { stored: 3 })).toBe(`Hosting 2 wikis, reachable directly. 1 more not taken by the node, which may be full. ${STOPS}`)
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

  it('say Orivon has not allowed listening when the editor has sockets but cannot accept connections, and while the tab is still a website', async () => {
    const app = { grants: async () => [] }
    for (const page of [{ orivon: { net: { connect () {} }, app }, process: {} }, { orivon: { net: { connect () {}, listen () {} }, app } }, { orivon: { net: { connect () {}, listen () {} } } }]) {
      vi.stubGlobal('window', page)
      const view = await hostingSwitches(() => {})
      expect(boxes(view)[0]?.hasAttribute('disabled')).toBe(true)
      expect((view as unknown as FakeElement).textContent).toContain('Orivon has not allowed this editor to accept connections from the network')
    }
  })

  it('say Orivon gave the tab no network access, not that the page is outside Orivon, when window.orivon is there without net.connect', async () => {
    // Orivon's fail-closed surface, exposed when its main-world install is unavailable or throws: every member refuses and `net` holds only `lookup`.
    const refuse = async () => { throw new Error('denied') }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      vi.stubGlobal('window', { orivon: { version: 0, app: { grants: refuse }, net: { lookup: refuse } } })
      const view = await hostingSwitches(() => {})
      expect(boxes(view).map((box) => [box.checked, box.hasAttribute('disabled')])).toEqual([[false, true], [true, false]])
      const text = (view as unknown as FakeElement).textContent
      expect(text).toContain('Hosting cannot start in this tab: Orivon did not give it the network access the IPFS node needs. Reload the editor to try again.')
      expect(text).not.toContain('Needs Orivon')
      expect(text).not.toContain('has not allowed')
      await hostingSwitches(() => {})
      expect(errors.mock.calls.map((call) => String(call[0]))).toEqual(['[decentrawiki] hosting could not start the IPFS node: Orivon did not give this tab the network access the node needs (window.orivon has no net.connect)'])
      expect(mem.nodeCalls).toBe(0)
    } finally {
      errors.mockRestore()
    }
  })

  it('still say Needs Orivon when window.orivon is absent or is not an object', async () => {
    for (const page of [{}, { orivon: undefined }, { orivon: null }, { orivon: true }]) {
      vi.stubGlobal('window', page)
      const view = await hostingSwitches(() => {})
      expect((view as unknown as FakeElement).textContent).toContain('Needs Orivon: other browsers give a page no IPFS node.')
    }
  })

  it('say hosting cannot start in this tab, and write the failure line once, when Orivon let the editor in but the tab has no Node globals', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const grant = { id: 'g', origin: 'https://editor', capability: 'tcp.connect', patterns: ['*:*'], grantedAt: 1 }
      vi.stubGlobal('window', { orivon: { net: { connect () {}, listen () {} }, app: { grants: async () => [grant] } } })
      for (let round = 0; round < 2; round++) {
        const view = await hostingSwitches(() => {})
        expect(boxes(view)[0]?.hasAttribute('disabled')).toBe(true)
        const text = (view as unknown as FakeElement).textContent
        expect(text).toContain('Hosting cannot start in this tab: Orivon has let this editor in, but this tab loaded without what the IPFS node starts through. Reload the editor to try again.')
        expect(text).not.toContain('has not allowed')
      }
      expect(errors.mock.calls.map((call) => String(call[0]))).toEqual(['[decentrawiki] hosting could not start the IPFS node: Orivon let the editor in, but this tab loaded without the Node globals the node starts through'])
      expect(mem.nodeCalls).toBe(0)
    } finally {
      errors.mockRestore()
    }
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

  it('show a node that did not start for stored wikis', async () => {
    inOrivon()
    mem.stored = 2
    mem.nodeUp = false
    const failed = await hostingSwitches(() => {})
    await vi.waitFor(() => expect((failed as unknown as FakeElement).textContent).toContain('The IPFS node did not start'))
    expect(mem.resumes).toBe(1)
  })

  it('give the node the stored wikis when Settings opens after the load could not start it, instead of starting a node that hosts nothing', async () => {
    inOrivon()
    mem.stored = 2
    const view = await hostingSwitches(() => {})
    await vi.waitFor(() => expect((view as unknown as FakeElement).textContent).toContain('Hosting 2 wikis, reachable directly.'))
    expect((view as unknown as FakeElement).textContent).not.toContain('Starting…')
    expect(mem.resumes).toBe(1)
    expect(mem.nodeCalls).toBe(0)
  })

  it('say a node that keeps running after hosting was turned off, and say nothing of one when none is left', async () => {
    inOrivon()
    mem.settings.set('hostWikis', false)
    const quiet = await hostingSwitches(() => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((quiet as unknown as FakeElement).textContent).toContain('Off.')
    expect((quiet as unknown as FakeElement).textContent).not.toContain('still running and listening')
    mem.lingering = 'elsewhere'
    const left = await hostingSwitches(() => {})
    await vi.waitFor(() => expect((left as unknown as FakeElement).textContent).toContain('is still running and listening'))
    expect((left as unknown as FakeElement).textContent).toContain('Turned off, it stops announcing your wikis at once; the node itself ends then only if this tab started it')
    expect(mem.resumes).toBe(0)
    mem.lingering = 'here'
    const own = await hostingSwitches(() => {})
    await vi.waitFor(() => expect((own as unknown as FakeElement).textContent).toContain('the IPFS node that this tab started is still running'))
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

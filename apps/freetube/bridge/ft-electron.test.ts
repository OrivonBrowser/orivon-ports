// What is FreeTube's own about this bridge: the roster of 34 members, the
// names bound to the behaviours upstream's renderer expects behind them, and
// generatePoToken, which is the only member here with a measured failure mode
// of its own.
//
// The behaviours themselves are the kit's (src/bridge/behaviours.test.ts) and
// so are the declaration's gates (src/bridge/declaration.test.ts). What runs
// below is the composed script, byte for byte what the browser is served.
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { bridgeSourceFor, runBridge } from '../../../src/testing/bridge-harness.ts'
import type { LoadOptions } from '../../../src/testing/bridge-harness.ts'

const source = await bridgeSourceFor('freetube')

function freshBridge (options: LoadOptions = {}) {
  return runBridge(source, options)
}

const MEMBERS = [
  'chooseDefaultFolder', 'clearInvidiousAuthorization', 'disableProxy', 'enableProxy', 'generatePoToken',
  'getDisableHardwareAcceleration', 'getNavigationHistory', 'getReplaceHttpCache', 'getSystemLocale',
  'handleChangeView', 'handleOpenInExternalPlayerResult', 'handleOpenUrl', 'handleSyncHistory',
  'handleSyncPlaylists', 'handleSyncProfiles', 'handleSyncSearchHistory', 'handleSyncSettings',
  'handleSyncSubscriptionCache', 'handleUpdateSearchInputText', 'isWaylandPlatform', 'openInExternalPlayer',
  'openInNewWindow', 'playerCacheGet', 'playerCacheSet', 'relaunch', 'requestFullscreen', 'requestPiP',
  'setInvidiousAuthorization', 'setZoomFactor', 'startPowerSaveBlocker', 'stopPowerSaveBlocker',
  'toggleDisableHardwareAcceleration', 'toggleReplaceHttpCache', 'writeToDefaultFolder'
] as const

describe('the roster', () => {
  // Every `window.ftElectron.<name>` call site in the clone's src/renderer.
  // A name dropped from members.json is a call site that gets `undefined is
  // not a function` deep inside FreeTube's own bundle.
  it('installs exactly the 34 members upstream calls, on window.ftElectron', () => {
    const { bridge, sandbox } = freshBridge()
    expect(Object.keys(bridge).sort()).toEqual([...MEMBERS])
    expect(sandbox.window['ftElectron']).toBe(bridge)
  })

  it('binds each name to what FreeTube expects behind it', async () => {
    const { bridge } = freshBridge({ navigator: { language: 'en-GB' }, orivon: {} })
    expect(bridge.getSystemLocale()).toBe('en-GB')
    expect(bridge.isWaylandPlatform()).toBe(false)
    expect(await bridge.getReplaceHttpCache()).toBe(false)
    expect(await bridge.getDisableHardwareAcceleration()).toBe(false)
    expect(bridge.toggleReplaceHttpCache()).toBeUndefined()
    expect(bridge.setInvidiousAuthorization('token', 'https://inv.example')).toBeUndefined()
    expect(await bridge.playerCacheGet('missing')).toBeUndefined()
    await bridge.playerCacheSet('k', { url: 'https://rr1.example' })
    expect(await bridge.playerCacheGet('k')).toEqual({ url: 'https://rr1.example' })
    await expect(bridge.chooseDefaultFolder()).rejects.toMatchObject({ reason: 'not-built' })
  })
})

describe('listeners', () => {
  const names = MEMBERS.filter((name) => name.startsWith('handle'))

  it.each(names)('%s records the callback and never calls it', (name) => {
    const { bridge, recordedListeners } = freshBridge()
    const callback = vi.fn()
    bridge[name](callback)
    expect(recordedListeners[name]).toBe(callback)
    expect(callback).not.toHaveBeenCalled()
  })

  it('handleUpdateSearchInputText also accepts null, as TopNav.vue unsubscribes with (App.vue keeps a live callback across route changes)', () => {
    const { bridge, recordedListeners } = freshBridge()
    expect(() => { bridge.handleUpdateSearchInputText(null) }).not.toThrow()
    expect(recordedListeners['handleUpdateSearchInputText']).toBeNull()
  })
})

describe('refused by name', () => {
  const cases: ReadonlyArray<[string, string, unknown[]]> = [
    ['openInExternalPlayer', 'excluded', [{ videoId: 'a' }]],
    ['relaunch', 'shell-owned', []],
    ['openInNewWindow', 'shell-owned', ['/watch/a', undefined, null]],
    ['enableProxy', 'shell-owned', ['socks5://127.0.0.1:9050']],
    ['disableProxy', 'shell-owned', []]
  ]

  it.each(cases)('%s throws a named error (%s) rather than being absent', (member, reason, args) => {
    const { bridge } = freshBridge()
    expect(() => bridge[member](...args)).toThrow(new RegExp(`ftElectron\\.${member} is unavailable`))
    try {
      bridge[member](...args)
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toMatchObject({ name: 'OrivonBridgeError', member, reason })
    }
  })
})

describe('getNavigationHistory', () => {
  it('returns exactly one active entry labelled the current title', async () => {
    const { bridge } = freshBridge({ title: 'Watch - FreeTube' })
    const options = await bridge.getNavigationHistory()
    expect(options).toEqual([{ label: 'Watch - FreeTube', active: true, value: 0 }])
    // TopNav.vue's own call site: `dropdownOptions.find(option => option.active)` must never be undefined.
    expect(options.find((option: { active: boolean }) => option.active)).toBeDefined()
  })
})

describe('generatePoToken (ADR-0019, web.context)', () => {
  const script = async () => ({ ok: true, status: 200, text: async () => 'var a=1;export{a as default};' })

  it('rejects "not-built" when orivon.web is absent, without ever fetching botGuardScript.js', async () => {
    const fetchSpy = vi.fn()
    const { bridge } = freshBridge({ orivon: {}, fetch: fetchSpy })
    await expect(bridge.generatePoToken('id', '{}', '{}', '{}')).rejects.toMatchObject({
      name: 'OrivonBridgeError',
      member: 'generatePoToken',
      reason: 'not-built'
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('splices the three JSON strings into the export tail, upstream-style', () => {
    const { app } = freshBridge()
    expect(app['rewriteBotGuardScript']('var a=1;export{a as default};', 'vid', '{"c":1}', '{"a":2}', '{"y":3}'))
      .toBe('var a=1;;a("vid",{"c":1},{"a":2},{"y":3})')
  })

  it('JSON-encodes a hostile video id instead of splicing it as a literal', () => {
    const { app } = freshBridge()
    // A videoId crafted to break out of the naive `"${videoId}"` splice: were
    // it spliced raw, the `"` right after `#/watch/` would close the string
    // literal early and the rest would run as script inside the youtube.com
    // context.
    const hostileId = '");globalThis.pwned=true;("'
    const rewritten = app['rewriteBotGuardScript']('var a=1;export{a as default};', hostileId, '{"c":1}', '{"a":2}', '{"y":3}')
    expect(rewritten).toBe(`var a=1;;a(${JSON.stringify(hostileId)},{"c":1},{"a":2},{"y":3})`)

    // Proven by executing the rewrite for real: `a` receives one string
    // argument, not several statements.
    const context: { received?: unknown[], pwned?: boolean } = {}
    vm.createContext(context)
    vm.runInContext('function a (...args) { received = args }', context)
    vm.runInContext(rewritten.replace('var a=1;', ''), context)
    expect(context.received).toEqual([hostileId, { c: 1 }, { a: 2 }, { y: 3 }])
    expect(context.pwned).toBeUndefined()
  })

  it('fetches the script once, opens a youtube.com context, evaluates the rewrite, and always closes', async () => {
    const evaluate = vi.fn(async () => 'THE_TOKEN')
    const close = vi.fn(async () => {})
    const openContext = vi.fn(async () => ({ evaluate, close }))
    const fetchSpy = vi.fn(script)
    const { bridge } = freshBridge({ orivon: { web: { openContext } }, fetch: fetchSpy })

    expect(await bridge.generatePoToken('vid', '{}', '{}', '{}')).toBe('THE_TOKEN')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(openContext).toHaveBeenCalledWith('https://www.youtube.com', { width: 1920, height: 1080 })
    expect(close).toHaveBeenCalledTimes(1)
    expect(evaluate).toHaveBeenCalledWith('var a=1;;a("vid",{},{},{})')

    // Cached: a second mint does not re-fetch the script.
    await bridge.generatePoToken('vid2', '{}', '{}', '{}')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(evaluate).toHaveBeenLastCalledWith('var a=1;;a("vid2",{},{},{})')
  })

  it('closes the context even when evaluate throws, and does not retry a real rejection', async () => {
    const close = vi.fn(async () => {})
    const openContext = vi.fn(async () => ({ evaluate: async () => { throw new Error('bad token') }, close }))
    const { bridge } = freshBridge({ orivon: { web: { openContext } }, fetch: vi.fn(script) })

    await expect(bridge.generatePoToken('vid', '{}', '{}', '{}')).rejects.toThrow('bad token')
    expect(close).toHaveBeenCalledTimes(1)
    expect(openContext).toHaveBeenCalledTimes(1)
  })

  // ../README.md's measurement: BotGuard's own opaque snapshot step hangs --
  // `evaluate` neither resolves nor rejects -- roughly half the time under
  // headless Xvfb with no real GPU. These drive that exact shape.
  describe('a stalled attempt (evaluate never settles)', () => {
    it('retries in a fresh context once an attempt exceeds its own deadline', async () => {
      vi.useFakeTimers()
      try {
        const opened: number[] = []
        const closed: number[] = []
        let openCount = 0
        const openContext = vi.fn(async () => {
          const mine = ++openCount
          opened.push(mine)
          return {
            evaluate: async () => mine === 1 ? await new Promise(() => {}) : 'TOKEN_FROM_ATTEMPT_2',
            close: async () => { closed.push(mine) }
          }
        })
        const { bridge, app } = freshBridge({ orivon: { web: { openContext } }, fetch: vi.fn(script) })

        const pending = bridge.generatePoToken('vid', '{}', '{}', '{}')
        const assertion = expect(pending).resolves.toBe('TOKEN_FROM_ATTEMPT_2')
        await vi.advanceTimersByTimeAsync(app['MINT_ATTEMPT_DEADLINE_MS'] + 1)
        await assertion

        expect(opened).toEqual([1, 2])
        // The stalled first context is closed (freeing its LIMITS.webContexts
        // slot) before the second one ever opens -- never both at once.
        expect(closed).toEqual([1, 2])
      } finally {
        vi.useRealTimers()
      }
    })

    it('gives up with a named, counted error once every attempt has stalled', async () => {
      vi.useFakeTimers()
      try {
        const closed: number[] = []
        let openCount = 0
        const openContext = vi.fn(async () => {
          const mine = ++openCount
          return { evaluate: async () => await new Promise(() => {}), close: async () => { closed.push(mine) } }
        })
        const { bridge, app } = freshBridge({ orivon: { web: { openContext } }, fetch: vi.fn(script) })
        const attempts = app['MINT_MAX_ATTEMPTS']

        const pending = bridge.generatePoToken('vid', '{}', '{}', '{}')
        const assertion = expect(pending).rejects.toMatchObject({ name: 'PoTokenMintStalledError', attempts })
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          await vi.advanceTimersByTimeAsync(app['MINT_ATTEMPT_DEADLINE_MS'] + 1)
        }
        await assertion

        expect(openContext).toHaveBeenCalledTimes(attempts)
        expect(closed).toHaveLength(attempts)
        await expect(pending).rejects.toBeInstanceOf(app['PoTokenMintStalledError'])
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('queues mints one at a time, as poTokenGenerator.js does', async () => {
    const order: string[] = []
    let openCount = 0
    const openContext = vi.fn(async () => {
      const mine = ++openCount
      order.push(`open${String(mine)}`)
      return {
        evaluate: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return `token${String(mine)}` },
        close: async () => { order.push(`close${String(mine)}`) }
      }
    })
    const { bridge } = freshBridge({ orivon: { web: { openContext } }, fetch: vi.fn(script) })

    const [first, second] = await Promise.all([
      bridge.generatePoToken('a', '{}', '{}', '{}'),
      bridge.generatePoToken('b', '{}', '{}', '{}')
    ])

    expect(first).toBe('token1')
    expect(second).toBe('token2')
    // The second mint's context never opens until the first one has closed.
    expect(order).toEqual(['open1', 'close1', 'open2', 'close2'])
  })
})

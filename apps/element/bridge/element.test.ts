// The composed bridge, byte for byte what the browser is served, in a fresh
// realm per test. ipcCall and seshat are driven the same way
// apps/web/src/vector/platform/IPCManager.ts drives them: send a
// {id,name,args} envelope, listen for the matching reply -- so a test here
// proves the same thing a call site in Element's own bundle would see.
import { describe, expect, it, vi } from 'vitest'
import { bridgeSourceFor, runBridge } from '../../../src/testing/bridge-harness.ts'
import type { LoadedBridge, LoadOptions } from '../../../src/testing/bridge-harness.ts'
import { fakeConsole, flush } from './test-helpers.ts'

const source = await bridgeSourceFor('element')

// apps/desktop/src/preload.cts's CHANNELS, verbatim.
const CHANNELS = [
  'app_onAction', 'before-quit', 'check_updates', 'install_update', 'ipcCall', 'ipcReply',
  'loudNotification', 'preferences', 'seshat', 'seshatReply', 'setBadgeCount', 'update-downloaded',
  'userDownloadCompleted', 'userDownloadAction', 'openDesktopCapturerSourcePicker',
  'userAccessToken', 'homeserverUrl', 'serverSupportedVersions', 'showToast'
]

// Every ipcCall name apps/desktop/src/ipc.ts answers, and the constant this
// bridge answers it with -- everything that does not need its own test below
// (getAppVersion and the three pickle-key calls have their own describe
// blocks; getAppVersion needs a stubbed fetch, and pickle-key round-trips
// are covered by pickle-key.test.ts against the real Web Crypto algorithm).
const IPC_ANSWERS: ReadonlyArray<readonly [string, readonly unknown[], unknown]> = [
  ['getUpdateFeedUrl', [], ''],
  ['setLanguage', [['en']], undefined],
  ['clearStorage', [], null],
  ['breadcrumbs', [], undefined],
  ['getSpellCheckEnabled', [], false],
  ['getSpellCheckLanguages', [], []],
  ['getAvailableSpellCheckLanguages', [], []],
  ['getDesktopCapturerSources', [{ types: ['screen'] }], []],
  ['callDisplayMediaCallback', ['source-id'], null]
]

const REFUSED_IPC_CALLS = ['setSpellCheckEnabled', 'setSpellCheckLanguages']

// apps/desktop/src/seshat.ts's answers for a build with no Seshat installed.
const SESHAT_FALSE: readonly string[] = ['supportsEventIndexing', 'isRoomIndexed', 'addHistoricEvents', 'addCrawlerCheckpoint', 'removeCrawlerCheckpoint']
const SESHAT_UNDEFINED: readonly string[] = ['closeEventIndex', 'deleteEventIndex', 'addEventToIndex', 'deleteEvent', 'commitLiveEvents', 'searchEventIndex', 'setUserVersion']
const SESHAT_ZERO: readonly string[] = ['getStats', 'getUserVersion']
const SESHAT_EMPTY_ARRAY: readonly string[] = ['loadFileEvents', 'loadCheckpoints']

function load (options: LoadOptions = {}): LoadedBridge {
  return runBridge(source, options)
}

/** Drives one ipcCall/seshat round trip exactly as IPCManager.call does: send an id, wait for the matching reply. */
async function call (bridge: Record<string, any>, sendChannel: string, replyChannel: string, name: string, args: readonly unknown[] = []): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const id = `${name}-${Math.random().toString(36).slice(2)}`
    bridge.on(replyChannel, (_event: unknown, payload: { id: string, reply?: unknown, error?: { message: string } }) => {
      if (payload.id !== id) return
      if (payload.error !== undefined) reject(new Error(payload.error.message))
      else resolve(payload.reply)
    })
    bridge.send(sendChannel, { id, name, args })
  })
}

describe('the roster', () => {
  it('installs exactly getSettingValue, initialise, on, send and setSettingValue on window.electron', () => {
    const { bridge, sandbox } = load()
    expect(Object.keys(bridge).sort()).toEqual(['getSettingValue', 'initialise', 'on', 'send', 'setSettingValue'])
    expect(sandbox.window['electron']).toBe(bridge)
  })

  it('refuses getSettingValue and setSettingValue as shell-owned', () => {
    const { bridge, internals } = load()
    for (const name of ['getSettingValue', 'setSettingValue']) {
      let caught: unknown
      try { bridge[name]() } catch (error) { caught = error }
      expect(caught).toBeInstanceOf(internals.BridgeError)
      expect((caught as { reason: string }).reason).toBe('shell-owned')
    }
  })
})

describe('on/send: the channel allowlist', () => {
  it.each(CHANNELS)('on() accepts channel %s', (channel) => {
    const { bridge } = load()
    expect(() => { bridge.on(channel, () => {}) }).not.toThrow()
  })

  it('on() logs and ignores an unknown channel, rather than throwing', () => {
    const console = fakeConsole()
    const { bridge } = load({ globals: { console } })
    expect(() => { bridge.on('not-a-real-channel', () => {}) }).not.toThrow()
    expect(console.calls).toEqual([['Unknown IPC channel not-a-real-channel ignored']])
  })

  it('send() logs and ignores an unknown channel, rather than throwing', () => {
    const console = fakeConsole()
    const { bridge } = load({ globals: { console } })
    expect(() => { bridge.send('not-a-real-channel') }).not.toThrow()
    expect(console.calls).toEqual([['Unknown IPC channel not-a-real-channel ignored']])
  })

  it('calls every listener on a channel as (event, ...args)', async () => {
    const { bridge } = load()
    const calls: unknown[][] = []
    bridge.on('check_updates', (...args: unknown[]) => calls.push(args))
    bridge.on('check_updates', (...args: unknown[]) => calls.push(args))
    bridge.send('check_updates')
    await flush()
    expect(calls).toHaveLength(2)
    for (const [event, available] of calls) {
      expect(event).toEqual({})
      expect(available).toBe(false)
    }
  })

  it('the 13 channels this port never acts on stay silent: no listener fires, nothing throws', async () => {
    const inert = ['before-quit', 'install_update', 'loudNotification', 'preferences', 'setBadgeCount', 'update-downloaded', 'userDownloadCompleted', 'userDownloadAction', 'openDesktopCapturerSourcePicker', 'userAccessToken', 'homeserverUrl', 'serverSupportedVersions', 'showToast']
    expect(inert).toHaveLength(13)
    const { bridge } = load()
    for (const channel of inert) {
      const fired = vi.fn()
      bridge.on(channel, fired)
      expect(() => { bridge.send(channel, {}) }).not.toThrow()
      await flush()
      expect(fired).not.toHaveBeenCalled()
    }
  })
})

describe('ipcCall', () => {
  it('answers getAppVersion by fetching "version" once, cached across calls', async () => {
    let requests = 0
    const { bridge } = load({
      fetch: async (input) => {
        requests += 1
        expect(input).toBe('version')
        return { ok: true, status: 200, text: async () => '1.12.29\n' }
      }
    })
    await expect(call(bridge, 'ipcCall', 'ipcReply', 'getAppVersion')).resolves.toBe('1.12.29')
    await expect(call(bridge, 'ipcCall', 'ipcReply', 'getAppVersion')).resolves.toBe('1.12.29')
    expect(requests).toBe(1)
  })

  it('answers getAppVersion with an error reply, not a hang, when the fetch fails', async () => {
    const { bridge } = load({ fetch: async () => ({ ok: false, status: 404, text: async () => '' }) })
    await expect(call(bridge, 'ipcCall', 'ipcReply', 'getAppVersion')).rejects.toThrow(/404/)
  })

  it.each(IPC_ANSWERS)('answers %s', async (name, args, expected) => {
    const { bridge } = load()
    await expect(call(bridge, 'ipcCall', 'ipcReply', name, args)).resolves.toEqual(expected)
  })

  it.each(REFUSED_IPC_CALLS)('refuses %s as shell-owned', async (name) => {
    const { bridge } = load()
    await expect(call(bridge, 'ipcCall', 'ipcReply', name, ['en'])).rejects.toThrow(/shell-owned|the browser owns this/)
  })

  it('focusWindow calls window.focus()', async () => {
    const { bridge, sandbox } = load()
    const focus = vi.fn()
    sandbox.window['focus'] = focus
    await expect(call(bridge, 'ipcCall', 'ipcReply', 'focusWindow')).resolves.toBeUndefined()
    expect(focus).toHaveBeenCalledOnce()
  })

  it.each([['navigateBack', 'back'], ['navigateForward', 'forward']])('%s calls history.%s()', async (name, method) => {
    const history = { back: vi.fn(), forward: vi.fn() }
    const { bridge } = load({ globals: { history } })
    await call(bridge, 'ipcCall', 'ipcReply', name)
    expect((history as Record<string, ReturnType<typeof vi.fn>>)[method]).toHaveBeenCalledOnce()
  })

  it('gives exactly one reply even when a handler throws synchronously', async () => {
    const { bridge } = load()
    const replies: unknown[] = []
    bridge.on('ipcReply', (_event: unknown, payload: unknown) => replies.push(payload))
    // getSettingValue is not an ipcCall name, so IPC_CALLS[name] is undefined
    // and dispatchNamed's own "Unknown IPC Call" throw is what fires here --
    // the same path a handler that threw internally would take.
    bridge.send('ipcCall', { id: 'x', name: 'not-a-real-call', args: [] })
    await flush()
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ id: 'x', error: { message: 'Unknown IPC Call: not-a-real-call' } })
  })

  it('an unknown ipcCall name gets main\'s own error text, not a hang', async () => {
    const { bridge } = load()
    await expect(call(bridge, 'ipcCall', 'ipcReply', 'not-a-real-call')).rejects.toThrow('Unknown IPC Call: not-a-real-call')
  })
})

describe('seshat', () => {
  it.each(SESHAT_FALSE)('answers %s with false', async (name) => {
    const { bridge } = load()
    await expect(call(bridge, 'seshat', 'seshatReply', name)).resolves.toBe(false)
  })

  it.each(SESHAT_UNDEFINED)('answers %s with undefined, resolved -- never a refusal', async (name) => {
    const { bridge } = load()
    await expect(call(bridge, 'seshat', 'seshatReply', name)).resolves.toBeUndefined()
  })

  it.each(SESHAT_ZERO)('answers %s with 0', async (name) => {
    const { bridge } = load()
    await expect(call(bridge, 'seshat', 'seshatReply', name)).resolves.toBe(0)
  })

  it.each(SESHAT_EMPTY_ARRAY)('answers %s with an empty array', async (name) => {
    const { bridge } = load()
    await expect(call(bridge, 'seshat', 'seshatReply', name)).resolves.toEqual([])
  })

  it('answers isEventIndexEmpty with true', async () => {
    const { bridge } = load()
    await expect(call(bridge, 'seshat', 'seshatReply', 'isEventIndexEmpty')).resolves.toBe(true)
  })

  it('deleteEventIndex resolves -- refusing it would break every fresh login', async () => {
    const { bridge } = load()
    await expect(call(bridge, 'seshat', 'seshatReply', 'deleteEventIndex')).resolves.toBeUndefined()
  })

  it('refuses initEventIndex as a native module this port excludes', async () => {
    const { bridge } = load()
    await expect(call(bridge, 'seshat', 'seshatReply', 'initEventIndex')).rejects.toThrow(/excluded/)
  })

  it('an unknown seshat name gets main\'s own error text', async () => {
    const { bridge } = load()
    await expect(call(bridge, 'seshat', 'seshatReply', 'not-a-real-call')).rejects.toThrow('Unknown IPC Call: not-a-real-call')
  })
})

describe('app_onAction: the call wake lock', () => {
  function withWakeLock () {
    const release = vi.fn(async () => {})
    const request = vi.fn<(kind: string) => Promise<{ release: () => Promise<void> }>>(async () => ({ release }))
    return { navigator: { wakeLock: { request } }, release }
  }

  it('requests a screen wake lock when a call connects, releases it when the call ends', async () => {
    const { navigator, release } = withWakeLock()
    const { bridge } = load({ navigator })
    bridge.send('app_onAction', { action: 'call_state', state: 'connected' })
    await flush()
    expect(navigator.wakeLock.request).toHaveBeenCalledWith('screen')
    bridge.send('app_onAction', { action: 'call_state', state: 'ended' })
    await flush()
    expect(release).toHaveBeenCalledOnce()
  })

  it('never requests a second lock while a call is already connected', async () => {
    const { navigator } = withWakeLock()
    const { bridge } = load({ navigator })
    bridge.send('app_onAction', { action: 'call_state', state: 'connected' })
    await flush()
    bridge.send('app_onAction', { action: 'call_state', state: 'connected' })
    await flush()
    expect(navigator.wakeLock.request).toHaveBeenCalledOnce()
  })

  it('tolerates having no Wake Lock API at all', async () => {
    const { bridge } = load()
    expect(() => { bridge.send('app_onAction', { action: 'call_state', state: 'connected' }) }).not.toThrow()
    await flush()
  })

  it('ignores an unrecognised action', async () => {
    const { navigator } = withWakeLock()
    const { bridge } = load({ navigator })
    bridge.send('app_onAction', { action: 'something-else' })
    await flush()
    expect(navigator.wakeLock.request).not.toHaveBeenCalled()
  })
})


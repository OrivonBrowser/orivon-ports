// window.electron.initialise(): the one call apps/web/src/vector/platform/
// ElectronPlatform.tsx awaits before it will render anything, so every
// rejection path here is a real "Element never starts" outcome, not a
// degraded feature. `navigator.locks` and `navigator.serviceWorker` are not
// part of the harness's FakeNavigator, so every test here supplies its own
// navigator (and, where needed, document) wholesale through `globals` --
// the harness's own documented escape hatch for exactly this.
import { describe, expect, it, vi } from 'vitest'
import { bridgeSourceFor, runBridge } from '../../../src/testing/bridge-harness.ts'
import type { FakeFetch } from '../../../src/testing/bridge-harness.ts'
import { fakeLocalStorage } from './test-helpers.ts'

const source = await bridgeSourceFor('element')

const CONFIG_BODY = { default_server_name: 'matrix.org' }

function fetchConfig (body: unknown = CONFIG_BODY, ok = true, status = 200): FakeFetch {
  return async (input) => {
    expect(input).toBe('orivon/element-config.json')
    return { ok, status, text: async () => JSON.stringify(body) }
  }
}

function immediateLocks (): Record<string, unknown> {
  return { request: async (_name: string, _opts: unknown, callback: () => Promise<unknown>) => await callback() }
}

interface Init {
  fetch?: FakeFetch
  navigator?: Record<string, unknown>
  document?: Record<string, unknown>
  extra?: Record<string, unknown>
}

function load (init: Init = {}): ReturnType<typeof runBridge> {
  return runBridge(source, {
    fetch: init.fetch ?? fetchConfig(),
    globals: {
      location: { protocol: 'http:' },
      crypto: globalThis.crypto,
      console: globalThis.console,
      window: { addEventListener: () => {}, focus: () => {} },
      navigator: { language: 'en-US', locks: immediateLocks(), ...init.navigator },
      ...(init.document === undefined ? {} : { document: init.document }),
      ...init.extra
    }
  })
}

describe('initialise()', () => {
  it('resolves the shape ElectronPlatform expects', async () => {
    const { bridge } = load()
    const result = await bridge.initialise()
    expect(result.protocol).toBe('http')
    expect(result.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(result.supportsBadgeOverlay).toBe(false)
    expect(result.supportedSettings).toEqual({
      'Electron.autoLaunch': false,
      'Electron.warnBeforeExit': false,
      'Electron.alwaysShowMenuBar': false,
      'Electron.showTrayIcon': false,
      'Electron.enableHardwareAcceleration': false,
      'Electron.enableContentProtection': false
    })
  })

  it('caches: the config is fetched once even if initialise() is called twice', async () => {
    let requests = 0
    const { bridge } = load({ fetch: async (input) => { requests += 1; return await fetchConfig()(input) } })
    await bridge.initialise()
    await bridge.initialise()
    expect(requests).toBe(1)
  })

  it('fills brand, help_url and web_base_url only when the served config leaves them out', async () => {
    const { bridge } = load({ fetch: fetchConfig({ default_server_name: 'matrix.org', brand: 'MyBrand' }) })
    const { config } = await bridge.initialise()
    expect(config.brand).toBe('MyBrand')
    expect(config.help_url).toBe('https://element.io/help')
    expect(config.web_base_url).toBe('https://app.element.io/')
    expect(config.default_server_name).toBe('matrix.org')
  })

  it('rejects, named, on an HTTP error fetching the config', async () => {
    const { bridge } = load({ fetch: fetchConfig({}, false, 404) })
    await expect(bridge.initialise()).rejects.toThrow(/404/)
  })

  it('rejects on invalid JSON, which is Element\'s own "invalid config" path', async () => {
    const { bridge } = load({ fetch: async () => ({ ok: true, status: 200, text: async () => 'not json' }) })
    await expect(bridge.initialise()).rejects.toThrow()
  })

  it('registers the service worker at sw.js', async () => {
    const register = vi.fn(async () => ({}))
    const { bridge } = load({ navigator: { serviceWorker: { register, addEventListener: () => {} } } })
    await bridge.initialise()
    expect(register).toHaveBeenCalledWith('sw.js')
  })

  it('still resolves when the service worker fails to register', async () => {
    const register = vi.fn(async () => { throw new Error('no sw support here') })
    const { bridge } = load({ navigator: { serviceWorker: { register, addEventListener: () => {} } } })
    await expect(bridge.initialise()).resolves.toBeDefined()
  })

  it('still resolves when navigator.serviceWorker does not exist at all', async () => {
    const { bridge } = load()
    await expect(bridge.initialise()).resolves.toBeDefined()
  })

  it('answers the service worker\'s userinfo message from localStorage, ignores everything else', async () => {
    let handler: ((event: unknown) => void) | undefined
    const localStorage = fakeLocalStorage({ mx_user_id: '@alice:example.org', mx_device_id: 'DEVICE1', mx_hs_url: 'https://example.org' })
    const { bridge } = load({
      navigator: { serviceWorker: { register: async () => ({}), addEventListener: (_type: string, listener: (event: unknown) => void) => { handler = listener } } },
      extra: { localStorage }
    })
    await bridge.initialise()
    const posted: unknown[] = []
    handler?.({ data: { type: 'userinfo', responseKey: 'abc' }, source: { postMessage: (message: unknown) => posted.push(message) } })
    handler?.({ data: { type: 'something-else' }, source: { postMessage: (message: unknown) => posted.push(message) } })
    expect(posted).toEqual([{ responseKey: 'abc', userId: '@alice:example.org', deviceId: 'DEVICE1', homeserver: 'https://example.org' }])
  })

  it('rejects, named, when navigator.locks is unavailable', async () => {
    const { bridge } = load({ navigator: { locks: undefined } })
    await expect(bridge.initialise()).rejects.toThrow(/navigator\.locks/)
  })

  it('waits for the session lock before resolving, and proceeds once it is granted', async () => {
    let release: (() => void) | undefined
    const locks = {
      request: async (_name: string, _opts: unknown, callback: () => Promise<unknown>) => await new Promise((resolve) => {
        release = () => { void callback().then(resolve, resolve) }
      })
    }
    const { bridge } = load({ navigator: { locks } })
    let resolved = false
    void bridge.initialise().then(() => { resolved = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved).toBe(false)
    release?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resolved).toBe(true)
  })
})

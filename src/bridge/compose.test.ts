// The seam between the declaration and the app's own file. Half of these fail
// at compose time and half at the first script in <head>; both are before the
// app's own bundle runs a line, which is the only place a bridge defect is
// cheap to read.
import { describe, expect, it } from 'vitest'
import { bridgeRuntime, composeBridge, composedBridgeName } from './compose.ts'
import { parseDeclaration } from './declaration.ts'
import { runDeclaration } from '../testing/bridge-harness.ts'

const runtime = await bridgeRuntime()

function compose (declaration: Record<string, unknown>, fragment?: string): string {
  return composeBridge({
    declaration: parseDeclaration(declaration, 'members.json'),
    declarationPath: 'members.json',
    ...(fragment === undefined ? {} : { appFragment: { path: 'app.js', source: fragment } }),
    runtime
  })
}

const listeners = { why: 'nothing to sync with', members: ['onThing'] }

describe('the app file and the declaration have to agree', () => {
  it('refuses hand members with no file to supply them', () => {
    expect(() => compose({ global: 'appApi', listeners, hand: ['doIt'] }))
      .toThrow(/"hand" names doIt, so the recipe needs a bridge.file/)
  })

  it('refuses a file with nothing to supply', () => {
    expect(() => compose({ global: 'appApi', listeners }, 'function appMembers () { return {} }'))
      .toThrow(/nothing to supply -- no global in members.json declares a "hand" member/)
  })

  it('refuses a file that does not declare appMembers, since it is spliced rather than imported', () => {
    expect(() => compose({ global: 'appApi', listeners, hand: ['doIt'] }, 'export const doIt = () => {}'))
      .toThrow(/must declare `function appMembers \(kit\)` returning doIt/)
  })
})

describe('install refuses a bridge that does not add up', () => {
  const declaration = { global: 'appApi', listeners, hand: ['doIt', 'doItTwice'] }

  it('names what the file did not supply', async () => {
    await expect(runDeclaration(declaration, { fragment: 'function appMembers () { return { doIt: () => {} } }' }))
      .rejects.toThrow(/declared in members.json but not returned by appMembers: doItTwice/)
  })

  it('names what the file supplied without declaring', async () => {
    const fragment = 'function appMembers () { return { doIt: () => {}, doItTwice: () => {}, surprise: () => {} } }'
    await expect(runDeclaration(declaration, { fragment }))
      .rejects.toThrow(/returned by appMembers but not declared in members.json's "hand": surprise/)
  })

  // The declaration's own duplicate check cannot see this one: `onThing` is
  // declared once, and the second copy arrives from the app's file at runtime.
  it('names both sides of a member the app file installs over a generated one', async () => {
    const fragment = 'function appMembers () { return { doIt: () => {}, doItTwice: () => {}, onThing: () => {} } }'
    await expect(runDeclaration(declaration, { fragment }))
      .rejects.toThrow(/appApi.onThing is installed twice, by listeners and by hand/)
  })
})

describe('what the composed script is', () => {
  const declaration = {
    global: 'appApi',
    listeners,
    constants: { isWayland: { value: false, why: 'the one guard around it never fires in a web build' } },
    refused: { relaunch: { reason: 'shell-owned', why: 'the browser owns the window' } },
    hand: ['doIt']
  }
  const fragment = 'function appMembers (kit) { kit.expose(\'secret\', 42); return { doIt: () => \'done\' } }'

  it('carries every why across as the comment above its member', () => {
    const source = compose(declaration, fragment)
    expect(source).toContain('// the one guard around it never fires in a web build')
    expect(source).toContain('// the browser owns the window')
    expect(source).toContain('// nothing to sync with')
  })

  it('installs on window under the declared global, and publishes internals for tests', async () => {
    const { bridge, sandbox, app } = await runDeclaration(declaration, { fragment })
    expect(sandbox.window['appApi']).toBe(bridge)
    expect(Object.keys(bridge).sort()).toEqual(['doIt', 'isWayland', 'onThing', 'relaunch'])
    expect(bridge.doIt()).toBe('done')
    expect(app['secret']).toBe(42)
  })

  it('is the same bytes every time, so a rebuild is a no-op when nothing changed', () => {
    expect(compose(declaration, fragment)).toBe(compose(declaration, fragment))
  })

  it('is served under a name that says which app it belongs to', () => {
    expect(composedBridgeName(parseDeclaration(declaration, 'members.json'), 'someapp')).toBe('appApi-bridge.js')
  })
})

// A preload that exposed several objects -- ASGARDEX exposes fourteen, seven
// of them storage objects with the same four member names. Nothing below is
// hypothetical: the repeated names are why `hand` is keyed by global.
describe('an app that exposes more than one global', () => {
  const declaration = {
    globals: {
      apiChainStorage: {
        refused: { exists: { reason: 'not-built', why: 'no store behind it yet' } },
        hand: ['get', 'save']
      },
      apiAssetStorage: {
        refused: { exists: { reason: 'not-built', why: 'no store behind it yet' } },
        hand: ['get', 'save']
      },
      apiMpc: {
        listeners: { why: 'progress events have no second process to arrive from', members: ['onQRCodeReady'] },
        hand: ['signBytes']
      }
    }
  }

  const fragment = `function appMembers (kit) {
    const store = (which) => ({ get: async (key) => which + ':' + key, save: async () => true })
    return {
      apiChainStorage: store('chain'),
      apiAssetStorage: store('asset'),
      apiMpc: { signBytes: () => 'signed' }
    }
  }`

  it('installs each global separately, and the same member name on two of them does not collide', async () => {
    const { globals, sandbox } = await runDeclaration(declaration, { fragment })

    expect(Object.keys(globals).sort()).toEqual(['apiAssetStorage', 'apiChainStorage', 'apiMpc'])
    expect(await globals['apiChainStorage']?.bridge['get']('k')).toBe('chain:k')
    expect(await globals['apiAssetStorage']?.bridge['get']('k')).toBe('asset:k')
    expect(sandbox.window['apiMpc']).toBe(globals['apiMpc']?.bridge)
  })

  it('names the owning global in a refusal, so the message matches the call the app made', async () => {
    const { globals } = await runDeclaration(declaration, { fragment })
    expect(() => globals['apiAssetStorage']?.bridge['exists']()).toThrow(/^apiAssetStorage.exists is unavailable/)
    expect(() => globals['apiChainStorage']?.bridge['exists']()).toThrow(/^apiChainStorage.exists is unavailable/)
  })

  it('records listeners per global', async () => {
    const { globals } = await runDeclaration(declaration, { fragment })
    const callback = (): void => {}
    globals['apiMpc']?.bridge['onQRCodeReady'](callback)
    expect(globals['apiMpc']?.recordedListeners['onQRCodeReady']).toBe(callback)
    expect(globals['apiChainStorage']?.recordedListeners).toEqual({})
  })

  it('refuses a flat appMembers return, which would silently keep one of the two gets', async () => {
    const flat = 'function appMembers () { return { get: () => {}, save: () => {}, signBytes: () => {} } }'
    await expect(runDeclaration(declaration, { fragment: flat }))
      .rejects.toThrow(/appMembers returned "get", which is not one of the globals this bridge declares/)
  })

  it('names the global as well as the member when a hand member is missing', async () => {
    const short = `function appMembers () {
      return { apiChainStorage: { get: () => {}, save: () => {} }, apiAssetStorage: { get: () => {} }, apiMpc: { signBytes: () => {} } }
    }`
    await expect(runDeclaration(declaration, { fragment: short }))
      .rejects.toThrow(/apiAssetStorage: declared in members.json but not returned by appMembers: save/)
  })

  it('reading .bridge says which global to ask for instead', async () => {
    const loaded = await runDeclaration(declaration, { fragment })
    expect(() => loaded.bridge).toThrow(/installs apiChainStorage, apiAssetStorage, apiMpc -- read .globals/)
  })
})

describe('the realm a bridge runs in', () => {
  // A `vm` realm has V8's intrinsics and nothing else, so a bridge that does
  // the ordinary thing -- encode JSON before handing it to byte-oriented
  // orivon.fs -- would fail here and work in a browser.
  const declaration = { global: 'appApi', hand: ['roundTrip', 'parseUrl'] }
  const fragment = `function appMembers () {
    return {
      roundTrip: (text) => new TextDecoder().decode(new TextEncoder().encode(text)),
      parseUrl: (href) => new URL(href).host
    }
  }`

  it('carries the web globals a bridge legitimately reads', async () => {
    const { bridge } = await runDeclaration(declaration, { fragment })
    expect(bridge.roundTrip('hello')).toBe('hello')
    expect(bridge.parseUrl('https://example.test/watch?v=1')).toBe('example.test')
  })

  it('takes anything else a particular bridge needs', async () => {
    const withCrypto = { global: 'appApi', hand: ['id'] }
    const loaded = await runDeclaration(withCrypto, {
      fragment: 'function appMembers () { return { id: () => crypto.randomUUID() } }',
      globals: { crypto: globalThis.crypto }
    })
    expect(loaded.bridge.id()).toMatch(/^[0-9a-f-]{36}$/)
  })
})

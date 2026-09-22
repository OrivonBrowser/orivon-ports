import vm from 'node:vm'
import { loadRecipe } from '../apps.ts'
import { bridgeRuntime, composeBridge, composeBridgeFor } from '../bridge/compose.ts'
import { parseDeclaration } from '../bridge/declaration.ts'
import { dirsFor } from '../paths.ts'

// One realm per test, holding the fake window/document/navigator/fetch a
// bridge reads, and running EXACTLY the bytes the browser is served -- the
// composed script, not the app's fragment. A bridge is a classic script with
// nothing to import, so there is no other way to reach it from a test.

export interface FakeVideo {
  requestPictureInPicture: () => Promise<void>
}

export interface FakeDocument {
  title: string
  documentElement: { style: Record<string, string>, requestFullscreen: () => Promise<void> }
  querySelector: (selector: string) => FakeVideo | null
}

export interface FakeNavigator {
  language: string
  wakeLock?: { request: (kind: string) => Promise<{ release: () => Promise<void> }> }
}

export type FakeFetch = (input: string) => Promise<{ ok: boolean, status: number, text: () => Promise<string> }>

export interface BridgeSandbox {
  window: Record<string, unknown> & { orivon?: Record<string, unknown> }
  document: FakeDocument
  navigator: FakeNavigator
  fetch: FakeFetch
  Uint8Array: typeof Uint8Array
  TextEncoder: typeof TextEncoder
  TextDecoder: typeof TextDecoder
  URL: typeof URL
  URLSearchParams: typeof URLSearchParams
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  __orivonBridgeInternals?: BridgeInternals
}

export interface InstalledGlobal {
  bridge: Record<string, any>
  recordedListeners: Record<string, (...args: unknown[]) => unknown>
}

export interface BridgeInternals {
  /** Every global the declaration installed, by name. */
  globals: Record<string, InstalledGlobal>
  /** Present only when the app exposed exactly one global. */
  global?: string
  bridge?: Record<string, any>
  recordedListeners?: Record<string, (...args: unknown[]) => unknown>
  BridgeError: new (member: string, reason: string, detail?: string, owner?: string) => Error & { member: string, reason: string, owner: string }
  refuse: (member: string, reason: string, detail?: string, owner?: string) => () => never
  app: Record<string, any>
}

export interface LoadOptions {
  readonly orivon?: Record<string, unknown>
  readonly document?: Partial<FakeDocument>
  readonly navigator?: Partial<FakeNavigator>
  readonly fetch?: FakeFetch
  readonly title?: string
  /** Anything else this bridge reads off the global object. A browser has more than a `vm` realm does; this is how a port adds what it needs without changing the harness. */
  readonly globals?: Record<string, unknown>
}

export interface LoadedBridge {
  /** The only global's members. An app that exposed several has `globals` instead, and reading this throws. */
  readonly bridge: Record<string, any>
  readonly recordedListeners: Record<string, (...args: unknown[]) => unknown>
  /** Every installed global by name, for an app whose preload exposed more than one. */
  readonly globals: Record<string, InstalledGlobal>
  readonly app: Record<string, any>
  readonly internals: BridgeInternals
  readonly sandbox: BridgeSandbox
  readonly source: string
}

function fakeDocument (options: LoadOptions): FakeDocument {
  return {
    title: options.title ?? 'app',
    documentElement: { style: {}, requestFullscreen: async () => {} },
    querySelector: () => null,
    ...options.document
  }
}

/**
 * Runs a composed bridge's source in a fresh realm.
 *
 * `setTimeout`/`clearTimeout` forward to the OUTER globals rather than being
 * bound once, so a test that calls `vi.useFakeTimers()` after loading still
 * controls the bridge's own timers.
 *
 * A `vm` realm carries V8's intrinsics and nothing else, so the web globals a
 * bridge legitimately reads are passed in from the outer realm: `Uint8Array`
 * (a cross-realm `instanceof` would otherwise make a member behave differently
 * here than in the window), `TextEncoder`/`TextDecoder` (`orivon.fs` is
 * byte-oriented by design, so a bridge storing JSON has to encode), and
 * `URL`/`URLSearchParams`. `options.globals` adds anything else a particular
 * bridge reads.
 */
export function runBridge (source: string, options: LoadOptions = {}): LoadedBridge {
  const sandbox = {
    window: { orivon: options.orivon },
    document: fakeDocument(options),
    navigator: { language: 'en-US', ...options.navigator },
    fetch: options.fetch ?? (async () => { throw new Error('fetch is not stubbed for this test') }),
    Uint8Array,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    setTimeout: ((...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args)) as typeof setTimeout,
    clearTimeout: ((...args: Parameters<typeof clearTimeout>) => { globalThis.clearTimeout(...args) }) as typeof clearTimeout,
    ...options.globals
  } as BridgeSandbox

  vm.createContext(sandbox as unknown as object)
  vm.runInContext(source, sandbox as unknown as object, { filename: 'orivon-bridge.js' })

  const internals = sandbox.__orivonBridgeInternals
  if (internals === undefined) throw new Error('the composed bridge did not install __orivonBridgeInternals -- it did not reach installBridges')

  const only = (what: string): never => {
    throw new Error(`this bridge installs ${Object.keys(internals.globals).join(', ')} -- read .globals['<name>'].${what}, not .${what}`)
  }
  return {
    get bridge () { return internals.bridge ?? only('bridge') },
    get recordedListeners () { return internals.recordedListeners ?? only('recordedListeners') },
    globals: internals.globals,
    app: internals.app,
    internals,
    sandbox,
    source
  }
}

/** A real port's composed bridge, exactly as `prepare` writes it. Compose once per test FILE and `runBridge` per test: the realm is what has to be fresh, not the bytes. */
export async function bridgeSourceFor (appId: string): Promise<string> {
  const composed = await composeBridgeFor(await loadRecipe(appId), dirsFor(appId))
  return composed.source
}

/** Composes a real port and runs it, for a test that needs only one realm. */
export async function loadBridge (appId: string, options: LoadOptions = {}): Promise<LoadedBridge> {
  return runBridge(await bridgeSourceFor(appId), options)
}

/** Composes and runs a declaration written inline, for the kit's own tests: no recipe, no app directory, the same code path a real port takes. */
export async function runDeclaration (declaration: unknown, options: LoadOptions & { readonly fragment?: string } = {}): Promise<LoadedBridge> {
  const path = 'members.json'
  const source = composeBridge({
    declaration: parseDeclaration(declaration, path),
    declarationPath: path,
    ...(options.fragment === undefined ? {} : { appFragment: { path: 'app.js', source: options.fragment } }),
    runtime: await bridgeRuntime()
  })
  return runBridge(source, options)
}

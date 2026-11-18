// The page node-start.js is run in, for its tests: a realm that holds a fake window and document.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { vi } from 'vitest'

export const source = readFileSync(new URL('./node-start.js', import.meta.url), 'utf8')
export const KEY = 'k'.repeat(40)
/** A page served from a content address: its files come over the IPFS network, so a first start that fails reads the node's files before it is made again. */
export const CONTENT_ADDRESS = 'https://bafybeitestcid.ipfs.orivon'

export interface FakeNode { api: ReturnType<typeof vi.fn>, reused: boolean }

export const attributes = (...pairs: Array<[string, string]>) => pairs.map(([name, value]) => ({ name, value }))

export function load (options: {
  window?: Record<string, unknown>
  startBitsocialNode?: (options: Record<string, unknown>, deps?: Record<string, unknown>) => Promise<FakeNode>
  loading?: boolean
  storage?: Record<string, string>
  entries?: number
  body?: { append: (element: any) => void }
  /** The page's origin. The default is a name no verifier serves: its files are here, so a first start that fails does not read them first. */
  origin?: string
  /** The bridge's text, when a test runs another list of the node's files than the one it ships with. */
  source?: string
  /** What this tab's session storage holds. */
  session?: Record<string, string>
} = {}) {
  const realFetch = vi.fn(async (_input: unknown, _init?: unknown) => new Response('real'))
  const started: Array<Record<string, unknown>> = []
  /** What each default start was given besides its options. */
  const dependencies: Array<Record<string, unknown> | undefined> = []
  const startBitsocialNode = options.startBitsocialNode ?? (async (given: Record<string, unknown>, deps?: Record<string, unknown>) => { started.push(given); dependencies.push(deps); return node() })
  const replaced: Array<{ attributes: Record<string, string> }> = []
  const held = Array.from({ length: options.entries ?? 1 }, () => ({
    attributes: attributes(['type', 'orivon-held-module'], ['crossorigin', ''], ['src', './assets/index-ABC.js']),
    replaceWith (script: { attributes: Record<string, string> }) { replaced.push(script) }
  }))
  const listeners = new Map<string, () => void>()
  const document = {
    readyState: options.loading === true ? 'loading' : 'complete',
    currentScript: { src: `${options.origin ?? 'https://seedit.test'}/orivon/node-start.js` },
    addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener) },
    querySelectorAll: (selector: string) => (selector === 'script[type="orivon-held-module"]' ? held : []),
    createElement: () => ({ attributes: {} as Record<string, string>, textContent: '', style: {} as Record<string, string>, removed: false, setAttribute (name: string, value: string) { this.attributes[name] = value }, remove () { this.removed = true } }),
    body: options.body
  }
  const window: Record<string, unknown> = {
    crossOriginIsolated: true,
    orivon: { version: 0, fs: { readFile () {} } },
    pkcRpcAuthKey: KEY,
    fetch: realFetch,
    BitsocialNodeClient: { startBitsocialNode },
    ...options.window
  }
  const warn = vi.fn()
  const log = vi.fn()
  const delays: number[] = []
  const noticeable: Array<() => void> = []
  const reload = vi.fn()
  const session = options.session ?? {}
  /** The ends of the reads' stall timers, which a test fires when it wants one read to hear nothing. */
  const stalls: Array<() => void> = []
  /** The page's clock, moved on by the length of each pause. */
  let now = 0
  const origin = options.origin ?? 'https://seedit.test'
  const storage = options.storage ?? {}
  const sandboxConsole = { warn, error: warn, log }
  vm.runInNewContext(options.source ?? source, {
    window, document, Response, URL, AbortController, EventTarget, Event, Date: { now: () => now }, console: sandboxConsole,
    setTimeout: (callback: () => void, ms: number) => { delays.push(ms); if (ms === 1_500) noticeable.push(callback); else if (ms === 330_000) stalls.push(callback); else { now += ms; queueMicrotask(callback) } return 0 },
    clearTimeout: () => undefined,
    location: { origin, href: `${origin}/`, reload },
    localStorage: { getItem: (name: string) => storage[name] ?? null, setItem: (name: string, value: string) => { storage[name] = value } },
    sessionStorage: { getItem: (name: string) => session[name] ?? null, setItem: (name: string, value: string) => { session[name] = value }, removeItem: (name: string) => { delete session[name] } }
  })
  const state = window['orivonBitsocialNode'] as { ready: Promise<FakeNode | null>, error: string | null, handle: FakeNode | null }
  return { window, state, realFetch, started, dependencies, replaced, held, listeners, warn, delays, noticeable, stalls, reload, session, storage, console: sandboxConsole, logged: log, setNow: (ms: number) => { now = ms }, fetch: window['fetch'] as (input: unknown, init?: unknown) => Promise<Response> }
}

export function node (): FakeNode {
  return { reused: false, api: vi.fn(async (_call: string, _options?: unknown) => Response.json({ ID: 'peer' })) }
}

export const settle = () => new Promise((resolve) => { setTimeout(resolve, 0) })

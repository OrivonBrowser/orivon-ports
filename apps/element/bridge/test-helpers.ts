// Fakes for the globals the harness's fixed sandbox does not provide:
// `indexedDB`, `localStorage`, `history`, `location` and `console`. This
// bridge reaches for them directly, exactly as it would on a real page --
// `options.globals` is the harness's own documented extension point for a
// bridge with unusual dependencies (../../../src/testing/bridge-harness.ts).
// Shared only within this app's own tests, never across ports (each app
// stands alone -- CLAUDE.md rule 7).

export function fakeLocalStorage (initial: Readonly<Record<string, string>> = {}): {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
} {
  const rows = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => { rows.set(key, value) },
    removeItem: (key) => { rows.delete(key) }
  }
}

interface FakeIDBRequest {
  result: unknown
  error: Error | null
  onsuccess: (() => void) | null
  onerror: (() => void) | null
  onupgradeneeded: (() => void) | null
}

/** Every IDBRequest a store operation returns settles on the next microtask, same as the real thing settling on a later task. */
function scheduled (run: () => unknown): FakeIDBRequest {
  const request: FakeIDBRequest = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null }
  Promise.resolve().then(() => {
    try {
      request.result = run()
      request.onsuccess?.()
    } catch (error) {
      request.error = error instanceof Error ? error : new Error(String(error))
      request.onerror?.()
    }
  })
  return request
}

/**
 * One in-memory database, covering only what ./element.js's pickle-key
 * functions use: `open` fires `onupgradeneeded` exactly once (real
 * IndexedDB semantics -- it only fires again if the version number rises),
 * then every open resolves the same stores. Object keys are JSON-encoded so
 * the two-part `[userId, deviceId]` array key round-trips like a real
 * structured-clone key would.
 */
export function fakeIndexedDb (): { open: (name: string, version: number) => FakeIDBRequest } {
  let upgraded = false
  const stores = new Map<string, Map<string, unknown>>()
  const db = {
    createObjectStore: (name: string): void => { stores.set(name, new Map()) },
    transaction: (_names: readonly string[]) => ({
      objectStore: (name: string) => {
        const rows = stores.get(name)
        if (rows === undefined) throw new Error(`no such object store: ${name}`)
        return {
          get: (key: unknown) => scheduled(() => rows.get(JSON.stringify(key))),
          put: (value: unknown, key: unknown) => scheduled(() => { rows.set(JSON.stringify(key), value) }),
          delete: (key: unknown) => scheduled(() => { rows.delete(JSON.stringify(key)) })
        }
      }
    })
  }
  return {
    open: () => {
      const request: FakeIDBRequest = { result: db, error: null, onsuccess: null, onerror: null, onupgradeneeded: null }
      Promise.resolve().then(() => {
        if (!upgraded) { upgraded = true; request.onupgradeneeded?.() }
        request.onsuccess?.()
      })
      return request
    }
  }
}

/** A silent console whose calls a test can assert on, since the sandbox provides none by default. */
export function fakeConsole (): { error: (...args: unknown[]) => void, calls: unknown[][] } {
  const calls: unknown[][] = []
  return { error: (...args) => { calls.push(args) }, calls }
}

/** Settles once every pending microtask (this bridge's own `Promise.resolve().then`, and this fake's) has run -- for a channel with no reply to await instead. */
export async function flush (): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

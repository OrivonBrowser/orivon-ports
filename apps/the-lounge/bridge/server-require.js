// The `require` the bundled server is given. Upstream is CommonJS, and two
// of its files call `require` with a name no bundler can follow: start.ts
// loads "../server" from a variable, and config.ts loads two config.js files
// by computed path. `bundled` answers a name the bundle already holds, and
// everything else goes to `fallback`, the shim's createRequire, which loads a
// CommonJS file from the app's own files. Pure, so a test can drive it.

/**
 * @param {{ bundled: Record<string, () => unknown>, fallback: ((id: string) => unknown) & { resolve?: (id: string) => string } }} sources
 * @returns {((id: string) => unknown) & { resolve: (id: string) => string }}
 */
export function makeRequire ({ bundled, fallback }) {
  const loaded = new Map()
  const require = (id) => {
    if (typeof id !== 'string') throw new TypeError(`The "id" argument must be of type string. Received ${typeof id}`)
    if (Object.hasOwn(bundled, id)) {
      if (!loaded.has(id)) loaded.set(id, bundled[id]())
      return loaded.get(id)
    }
    return fallback(id)
  }
  require.resolve = (id) => {
    if (Object.hasOwn(bundled, id)) return id
    if (typeof fallback.resolve !== 'function') throw new Error(`require.resolve("${id}") is not available`)
    return fallback.resolve(id)
  }
  return require
}

// The banner of the server bundle. esbuild's `__require` helper picks the global `require` once, when
// the bundle starts, and a forked child of the shim already has one (relative to the app's root) before
// any of the bundle runs. A `require` installed later, by install-require.js, would never be the one
// `__require` holds; so the banner puts a forwarder there first, ahead of the helper, and
// install-require.js points it at the real one through `require.target`.

export const REQUIRE_FORWARDER = `globalThis.require = Object.assign((id) => globalThis.require.target(id), {
  resolve: (id) => globalThis.require.target.resolve(id),
  target: undefined
})`

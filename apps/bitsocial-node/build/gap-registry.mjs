// Workaround, deletable when the shim gives an app a public way to register a builtin for run-time `require`: the shim's
// registry (src/shim/polyfills/cjs-builtins.ts) is imported from its source file in the Orivon checkout the build
// takes the shim from. The file is at that path in v0.1.0 and in main.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** @param {string} mvpRoot the Orivon checkout the shim is taken from */
export function registryResolver (mvpRoot) {
  const file = join(mvpRoot, 'src', 'shim', 'polyfills', 'cjs-builtins.ts')
  if (!existsSync(file)) throw new Error(`${file} does not exist: this Orivon checkout has no builtin registry to import`)
  return {
    name: 'bitsocial-shim-registry',
    /** @param {import('esbuild').PluginBuild} build */
    setup (build) {
      build.onResolve({ filter: /^orivon-shim-registry$/ }, () => ({ path: file }))
    }
  }
}

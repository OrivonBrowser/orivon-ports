// Our build wrapper for upstream ASGARDEX's electron-vite config. It runs
// upstream's OWN `electron.vite.config.mjs` from the clone and removes one
// thing from its renderer: `@rollup/plugin-typescript`. Why that makes the
// build the same bytes every time: ./README.md, "Two builds, one tree".
//
// The recipe copies this file into the clone's root before the build, because
// electron-vite bundles a config and resolves its imports from the file's own
// folder. Nothing of upstream's is edited.

/** The name `@rollup/plugin-typescript` gives the plugin object it returns. */
const PLUGIN_NAME = 'typescript'

/**
 * `config` without the renderer's TypeScript plugin. A config that does not
 * carry exactly one of them throws, because a wrapper that quietly stopped
 * removing it would put the race back with nothing to say so.
 */
export function withoutTypescriptPlugin (config) {
  const plugins = config?.renderer?.plugins
  if (!Array.isArray(plugins)) throw new Error('upstream electron.vite.config.mjs has no renderer.plugins array')
  const kept = plugins.filter((plugin) => plugin?.name !== PLUGIN_NAME)
  if (kept.length !== plugins.length - 1) {
    throw new Error(`expected exactly one "${PLUGIN_NAME}" plugin in the renderer, found ${plugins.length - kept.length}: the wrapper must be revisited`)
  }
  return { ...config, renderer: { ...config.renderer, plugins: kept } }
}

export default async function orivonConfig (env) {
  const { default: upstream } = await import('./electron.vite.config.mjs')
  return withoutTypescriptPlugin(await (typeof upstream === 'function' ? upstream(env) : upstream))
}

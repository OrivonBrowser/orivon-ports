// What an app's own webpack config has to be told before it builds an Orivon
// app, without forking it. A wrapper requires upstream's config, calls these,
// and exports the result.
//
// CommonJS, and required by relative path from `apps/<id>/*.config.cjs`:
// webpack runs that wrapper inside the app's clone, so a bare specifier would
// resolve against the clone's node_modules rather than this repository.
//
// See docs/porting-guide.md step 4 for the two traps these close.

'use strict'

const { isAbsolute, relative, sep } = require('node:path')

/** The clone being built. The executor runs the build with the clone as its working directory; `envVar` is for a wrapper that is also run by hand. */
function cloneRoot (envVar) {
  const override = envVar === undefined ? undefined : process.env[envVar]
  return override === undefined || override === '' ? process.cwd() : override
}

/**
 * A `require` that resolves against the CLONE, not this repository. Upstream's
 * webpack, its plugins and its own `_scripts/` all live there, and a wrapper
 * that reached for this repository's copy would be comparing plugin instances
 * against a different class object -- every `instanceof` silently false.
 */
function requireFromClone (root) {
  return (specifier) => require(require.resolve(specifier, { paths: [root] }))
}

function assertCount (patched, expect, what) {
  const satisfied = expect === 'at-least-one' ? patched > 0 : patched === expect
  if (satisfied) return
  const wanted = expect === 'at-least-one' ? 'at least one' : String(expect)
  throw new Error(`orivon build wrapper: expected ${wanted} ${what} to patch, patched ${String(patched)} -- upstream's config changed shape`)
}

/**
 * Patches every plugin instance of a class and counts them, because the
 * counting is the point: a config that quietly stopped carrying the plugin a
 * port depends on otherwise builds a DIFFERENT app, successfully.
 *
 * `patch` returning `false` means "not this instance" and does not count --
 * how a wrapper picks one of several instances of the same class apart.
 */
function patchPlugins (config, Ctor, patch, options = {}) {
  const expect = options.expect === undefined ? 1 : options.expect
  const what = options.what === undefined ? (Ctor.name || 'plugin') : options.what
  let patched = 0
  for (const plugin of config.plugins || []) {
    if (!(plugin instanceof Ctor)) continue
    if (patch(plugin) === false) continue
    patched += 1
  }
  assertCount(patched, expect, what)
  return patched
}

function within (root, candidate) {
  const inside = relative(root, candidate)
  return inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))
}

function copyPatterns (config) {
  const found = []
  for (const plugin of config.plugins || []) {
    if (plugin === null || typeof plugin !== 'object' || !Array.isArray(plugin.patterns)) continue
    for (const pattern of plugin.patterns) {
      if (pattern !== null && typeof pattern === 'object') found.push(pattern)
    }
  }
  return found
}

/**
 * Sends the build to `to`, INCLUDING the copy patterns that ignore
 * `output.path` because their own `to:` is absolute. Changing `output.path`
 * alone leaves those writing wherever upstream hardcoded -- assets missing
 * from this build, and this build writing into another target's `dist/`.
 *
 * `from` is the prefix to rewrite, when upstream hardcodes one. Whether or not
 * it is given, any pattern still pointing outside `to` afterwards throws: a
 * port has no business writing anywhere but its own output directory, and a
 * wrapper cannot assert about a path it has not thought of.
 */
function retargetOutput (config, options) {
  const to = options.to
  const from = options.from
  config.output = config.output || {}
  config.output.path = to

  let moved = 0
  const escaping = []
  for (const pattern of copyPatterns(config)) {
    if (typeof pattern.to !== 'string') continue
    if (from !== undefined && pattern.to.startsWith(from)) {
      pattern.to = to + pattern.to.slice(from.length)
      moved += 1
      continue
    }
    if (isAbsolute(pattern.to) && !within(to, pattern.to)) escaping.push(pattern.to)
  }

  if (escaping.length > 0) {
    throw new Error(
      `orivon build wrapper: ${String(escaping.length)} copy pattern(s) write outside ${to} and would leave this build incomplete ` +
      `while overwriting another target's output:\n  ${escaping.join('\n  ')}\nPass their prefix as { from } to move them.`
    )
  }
  return moved
}

/**
 * An empty fallback for the node builtins an isomorphic library reaches for.
 * `false` is the honest answer for a browser bundle: the library checks, and
 * takes its web path.
 */
const NODE_BUILTINS = ['fs', 'path', 'stream', 'crypto', 'http', 'https', 'zlib', 'url', 'net', 'tls', 'child_process']

function addBrowserFallbacks (config, extra = {}) {
  const fallback = {}
  for (const name of NODE_BUILTINS) fallback[name] = false
  config.resolve = config.resolve || {}
  config.resolve.fallback = { ...config.resolve.fallback, ...fallback, ...extra }
  return config
}

module.exports = { addBrowserFallbacks, cloneRoot, patchPlugins, requireFromClone, retargetOutput, NODE_BUILTINS }

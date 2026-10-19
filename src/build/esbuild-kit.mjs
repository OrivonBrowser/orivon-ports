// What an app's esbuild config repeats from every other app that bundles
// code for the Orivon shim: finding orivon-mvp's plugin, stamping an install
// tree, gating a bundle on the inputs it holds, and saying what went wrong.
// Which modules a port refuses, which inputs it requires and why, and how it
// rewrites upstream's text stay in the app.
//
// ES module, imported by relative path from `apps/<id>/esbuild.orivon.config.mjs`
// (and from the `bridge/` files its tests cover): the config runs inside the
// app's clone, where a bare specifier would resolve against upstream's
// node_modules. Like webpack-kit.cjs, each call throws when the shape it
// depends on is gone, so a bundle never quietly differs from the one meant.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/**
 * orivon-mvp's shim bundler plugin module: `ORIVON_MVP_ROOT`, else the
 * checkout beside this repository. Throws naming the file when the checkout
 * has no `src/shim/bundler/`, and when the module no longer exports
 * `orivonShimPlugin`.
 */
export async function loadShimPlugin (env = process.env, repoRoot = REPO_ROOT) {
  const root = env.ORIVON_MVP_ROOT ?? resolve(repoRoot, '..', 'orivon-mvp')
  const file = join(root, 'src', 'shim', 'bundler', 'esbuild-plugin.ts')
  if (!existsSync(file)) {
    throw new Error(`${file} does not exist. Set ORIVON_MVP_ROOT to an orivon-mvp checkout that has src/shim/bundler/ (default: ../orivon-mvp beside this repository).`)
  }
  const plugin = await import(pathToFileURL(file).href)
  if (typeof plugin.orivonShimPlugin !== 'function') {
    throw new Error(`${file} no longer exports orivonShimPlugin: orivon-mvp's shim bundler changed shape`)
  }
  return plugin
}

/**
 * A hex digest over each file's name and bytes, in name order, `length`
 * characters long. A name and a body cannot trade bytes, because each is
 * length-prefixed. `entries` is `[name, bytes][]`; the length is the app's,
 * since it is part of the paths the app's own bundle names.
 */
export function stampOf (entries, length) {
  if (!Number.isInteger(length) || length < 1 || length > 64) throw new Error(`stampOf needs a length from 1 to 64, got ${String(length)}`)
  const hash = createHash('sha256')
  for (const [name, bytes] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    hash.update(`${name}\0${String(bytes.length)}\0`)
    hash.update(bytes)
  }
  return hash.digest('hex').slice(0, length)
}

/** Each `[name, path]` read once, as `[name, bytes]` in name order: the files an install tree is stamped from. */
export async function readFiles (sources) {
  const files = []
  for (const [name, path] of sources) files.push([name, await readFile(path)])
  return files.sort((a, b) => (a[0] < b[0] ? -1 : 1))
}

/**
 * What is wrong with a bundle, from its metafile's input paths (relative to
 * the clone, posix). Each `required` is `{path, why}` and each `forbidden`
 * `{prefix, why}`; the `why` is what a person reads when the gate fails, so it
 * names what the input proves or what refused it. Empty when the bundle can run.
 */
export function checkMetafile (inputs, { required, forbidden }) {
  const problems = []
  const present = new Set(inputs)
  for (const { path, why } of required) {
    if (!present.has(path)) problems.push(`the bundle is missing ${path}: ${why}`)
  }
  for (const { prefix, why } of forbidden) {
    const found = inputs.find((path) => path.startsWith(prefix))
    if (found !== undefined) problems.push(`the bundle holds ${found}: ${why}`)
  }
  return problems
}

const UNMAPPED = /^'([^']+)' is a Node builtin the Orivon shim has no module for \(imported from ([^)]+)\)/

/**
 * The builtins the shim has no module for, and who imports each, from the
 * texts of esbuild's errors. The plugin fails the build on each one; this is
 * the list a person reads to see what is left to build in the shim.
 */
export function unmappedBuiltins (errorTexts) {
  const found = new Map()
  for (const text of errorTexts) {
    const match = UNMAPPED.exec(text)
    if (match === null) continue
    found.set(match[1], [...(found.get(match[1]) ?? []), match[2]])
  }
  return found
}

/** esbuild's warnings, one line each. */
export function printWarnings (result) {
  for (const warning of result.warnings) {
    const at = warning.location === null || warning.location === undefined ? '' : ` (${warning.location.file}:${String(warning.location.line)})`
    console.warn(`warning: ${warning.text}${at}`)
  }
}

/**
 * What a failed build prints: the shim's missing builtins as a list of who
 * imports them (`relativeTo` shortens the importers), then every other error
 * esbuild collected, or the thrown message when it collected none. The caller
 * exits.
 */
export function printBuildFailure (error, relativeTo = (path) => path) {
  const texts = (error.errors ?? []).map((entry) => entry.text)
  const builtins = unmappedBuiltins(texts)
  if (builtins.size > 0) {
    console.error('The Orivon shim has no module for these Node builtins (orivon-mvp: src/shim/module-map.ts):')
    for (const [specifier, importers] of builtins) {
      console.error(`  ${specifier}, imported by ${[...new Set(importers.map(relativeTo))].join(', ')}`)
    }
  }
  for (const text of texts) if (unmappedBuiltins([text]).size === 0) console.error(text)
  if (texts.length === 0) console.error(error instanceof Error ? error.message : error)
}

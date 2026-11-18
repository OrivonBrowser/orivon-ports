// An esbuild plugin that rewrites the text of files of pkc-js's own bundle. Each patch names the gap it works past and
// throws when the text it expects is gone, so a pkc-js that changed breaks the build and never ships half a fix.

import { readFile } from 'node:fs/promises'

/**
 * @typedef {object} Patch
 * @property {string} name the gap it works past
 * @property {RegExp} file the files it applies to, matched on the absolute path
 * @property {(text: string, path: string) => string} apply returns the new text; throws when the text it needs is not there
 */

/** Replaces `from`, which must occur, with `to`. @param {string} from @param {string} to @returns {Patch['apply']} */
export function replaceText (from, to) {
  return (text, path) => {
    if (!text.includes(from)) throw new Error(`text not found in ${path}: ${from.slice(0, 80)}`)
    return text.replace(from, () => to)
  }
}

/**
 * Replaces `from`, which must occur exactly once: a text that moved, or that now appears in two places, is not the
 * place the patch was written for. @param {string} from @param {string} to @returns {Patch['apply']}
 */
export function replaceOnce (from, to) {
  return (text, path) => {
    const first = text.indexOf(from)
    if (first === -1) throw new Error(`text not found in ${path}: ${from.slice(0, 80)}`)
    if (text.indexOf(from, first + from.length) !== -1) throw new Error(`text found more than once in ${path}: ${from.slice(0, 80)}`)
    return text.slice(0, first) + to + text.slice(first + from.length)
  }
}

/**
 * Throws naming each patch of `patches` that was applied to no file. A patch whose `file` matches nothing never runs, so
 * a chunk that was renamed or dropped would otherwise ship without its fix.
 * @param {Patch[]} patches @param {Set<string>} applied what `textPatches` filled
 */
export function requireApplied (patches, applied) {
  const missing = patches.filter((patch) => !applied.has(patch.name))
  if (missing.length > 0) throw new Error(`no file matched the patch${missing.length > 1 ? 'es' : ''} ${missing.map((patch) => `"${patch.name}"`).join(', ')}: pkc-js's chunks moved`)
}

/**
 * @param {Patch[]} patches
 * @param {Set<string>} applied filled with the name of each patch that was applied to a file
 */
export function textPatches (patches, applied) {
  return {
    name: 'bitsocial-text-patches',
    /** @param {import('esbuild').PluginBuild} build */
    setup (build) {
      build.onLoad({ filter: /\.js$/ }, async (args) => {
        const hits = patches.filter((patch) => patch.file.test(args.path))
        if (hits.length === 0) return undefined
        let text = await readFile(args.path, 'utf8')
        for (const patch of hits) {
          try { text = patch.apply(text, args.path) } catch (error) { throw new Error(`patch "${patch.name}": ${error instanceof Error ? error.message : String(error)}`) }
          applied.add(patch.name)
        }
        return { contents: text, loader: 'js' }
      })
    }
  }
}

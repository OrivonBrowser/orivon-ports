// What makes a build wrapper's bundle depend on the machine that built it, as a
// pure function over its text.
//
// An unminified esbuild bundle names each module by its path, and the Node shim
// comes from the orivon-mvp checkout, so a wrapper that bundles the shim without
// `stableBundlePaths()` (src/build/esbuild-kit.mjs) writes that checkout's
// folder into the tree. The tree's hash is then the machine's, and an
// independent build cannot confirm a published one. A wrapper is a file under
// `apps/` that calls `loadShimPlugin()` or `orivonShimPlugin()`; each esbuild
// `plugins` list that holds the shim plugin must end with `stableBundlePaths()`.

export interface BuildFile {
  /** Repository-relative, with forward slashes. */
  path: string
  text: string
}

const SHIM_CALL = /\b(?:loadShimPlugin|orivonShimPlugin)\s*\(/
const PLUGINS_LIST = /\bplugins\s*:\s*\[/g
const SHIM_PLUGIN = /\borivonShimPlugin\s*\(/g
const STABLE_LAST = /^stableBundlePaths\s*\(/

/** The code with its comments blanked and every newline kept, so an offset still names its line. */
function withoutComments (text: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/g, '')
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, (match, before: string) => `${before}${blank(match.slice(before.length))}`)
}

/** The offset just past the `]` that closes the list opened at `open`, or -1. */
function closeOf (code: string, open: number): number {
  let depth = 0
  for (let at = open; at < code.length; at += 1) {
    const char = code[at]
    if (char === '[' || char === '(' || char === '{') depth += 1
    else if (char === ']' || char === ')' || char === '}') {
      depth -= 1
      if (depth === 0) return at + 1
    }
  }
  return -1
}

/** The elements of a list's body, split at its top-level commas. */
function elementsOf (body: string): string[] {
  const elements: string[] = []
  let depth = 0
  let start = 0
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at]
    if (char === '[' || char === '(' || char === '{') depth += 1
    else if (char === ']' || char === ')' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) { elements.push(body.slice(start, at).trim()); start = at + 1 }
  }
  elements.push(body.slice(start).trim())
  return elements.filter((element) => element !== '')
}

const lineOf = (code: string, offset: number): number => code.slice(0, offset).split('\n').length

/**
 * Every place a wrapper in `files` bundles the Orivon shim in a way that leaves the build machine's
 * folders in the bytes: a `plugins` list with `orivonShimPlugin()` that does not end with
 * `stableBundlePaths()`, a shim plugin passed anywhere but such a list, and a wrapper that loads the
 * plugin and never passes it.
 */
export function shimPathProblems (files: readonly BuildFile[]): string[] {
  const problems: string[] = []
  for (const file of files) {
    const code = withoutComments(file.text)
    if (!SHIM_CALL.test(code)) continue
    const listed = new Set<number>()
    for (const list of code.matchAll(PLUGINS_LIST)) {
      const open = list.index + list[0].length - 1
      const close = closeOf(code, open)
      if (close === -1) continue
      const body = code.slice(open + 1, close - 1)
      const shims = [...body.matchAll(SHIM_PLUGIN)]
      for (const shim of shims) listed.add(open + 1 + shim.index)
      if (shims.length === 0) continue
      const last = elementsOf(body).at(-1) ?? ''
      if (!STABLE_LAST.test(last)) {
        problems.push(`${file.path}:${String(lineOf(code, open))}: the plugins list passes orivonShimPlugin() and does not end with stableBundlePaths(), so the bundle names the folder orivon-mvp was checked out in (src/build/esbuild-kit.mjs)`)
      }
    }
    const calls = [...code.matchAll(SHIM_PLUGIN)]
    for (const call of calls) {
      if (!listed.has(call.index)) {
        problems.push(`${file.path}:${String(lineOf(code, call.index))}: orivonShimPlugin() is passed outside a literal \`plugins: [...]\` list, where this guard cannot see whether stableBundlePaths() follows it`)
      }
    }
    if (calls.length === 0) {
      problems.push(`${file.path}: loads the shim plugin (loadShimPlugin) and never passes orivonShimPlugin() to esbuild`)
    }
  }
  return problems
}

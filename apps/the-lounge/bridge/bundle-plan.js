// The build's decisions, as pure functions: where a bundled module believes
// it lives, which require() calls may survive in the server bundle, whether
// the bundle holds everything the server loads by a computed name, and the
// stamp that says an install tree has changed. esbuild.orivon.config.mjs does
// the I/O and throws on what these return; nothing here touches the disk, so
// each gate has a test that hands it a real violation (README.md, Design notes).

import { createHash } from 'node:crypto'
import { posix } from 'node:path'

/** Where the launcher materialises upstream's install tree, under the app's virtual root. */
export const INSTALL_DIR = 'lounge-install'

/** What the server's own `THELOUNGE_HOME` is, under the same root. */
export const HOME_DIR = 'lounge-home'

/**
 * The layout tsc gives upstream (`dist/server/...` beside `dist/defaults/`),
 * which its `__dirname` arithmetic assumes: `server/rootpath.ts` climbs two
 * levels from `dist/server` to the root that holds `public/`.
 */
const DIST = 'dist'

/** The directory a clone file reports as its own, and its file name, or null for a file that keeps none. */
export function moduleLocation (file, cloneRoot, installRoot) {
  const rel = posix.relative(cloneRoot, file)
  if (rel.startsWith('..') || posix.isAbsolute(rel) || rel.endsWith('.d.ts')) return null
  if (!rel.startsWith('server/') && !rel.startsWith('shared/')) return null
  const built = rel.replace(/\.(?:ts|mts|cts)$/, '.js')
  return { dirname: posix.join(installRoot, DIST, posix.dirname(built)), filename: posix.join(installRoot, DIST, built) }
}

const USES_DIRNAME = /\b__(?:dirname|filename)\b/
const USES_MODULE = /\bmodule\.exports\b/

/**
 * Gives a clone module the names Node's CommonJS wrapper would: `__dirname`
 * and `__filename`, and a `module` of its own (server/plugins/changelog.ts
 * sets a flag through `module.exports`). Declared on the source's first line,
 * so a stack trace keeps its line numbers, and only what the file reads: the
 * port touches nothing else.
 */
export function withModuleScope (contents, location) {
  if (location === null) return contents
  const names = []
  if (USES_DIRNAME.test(contents)) names.push(`__dirname = ${JSON.stringify(location.dirname)}, __filename = ${JSON.stringify(location.filename)}`)
  if (USES_MODULE.test(contents)) names.push('module = { exports: {} }')
  return names.length === 0 ? contents : `const ${names.join(', ')}; ${contents}`
}

// --- require() calls left in the bundle ------------------------------------

/**
 * Blanks comments and the inside of string and template literals, keeping
 * every offset, so a search for `require(` does not find one inside the
 * shim's worker source, which the bundle carries as a string. A `/` starts a
 * regular expression after an operator or an opening bracket, and divides
 * after a value: right for esbuild's own output, which is what this reads.
 */
export function blankLiterals (code) {
  const out = code.split('')
  const resume = []
  let braces = 0
  let previous = ''
  let i = 0
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ' }
  // Template text from `i` to the next `${` (true: code follows) or the closing backtick.
  const templateText = () => {
    const start = i
    while (i < code.length && code[i] !== '`') {
      if (code[i] === '$' && code[i + 1] === '{') {
        blank(start, i)
        resume.push(braces++)
        i += 2
        return true
      }
      i += code[i] === '\\' ? 2 : 1
    }
    blank(start, i)
    i++
    return false
  }
  while (i < code.length) {
    const c = code[i]
    const next = code[i + 1]
    if (c === '/' && next === '/') { const s = i; while (i < code.length && code[i] !== '\n') i++; blank(s, i); continue }
    if (c === '/' && next === '*') { const s = i; i = code.indexOf('*/', i + 2); i = i < 0 ? code.length : i + 2; blank(s, i); continue }
    if (c === '"' || c === "'") {
      const s = ++i
      while (i < code.length && code[i] !== c && code[i] !== '\n') i += code[i] === '\\' ? 2 : 1
      blank(s, i)
      i++
      previous = 'v'
      continue
    }
    if (c === '`') { i++; previous = templateText() ? '{' : 'v'; continue }
    if (c === '/' && (previous === '' || '(,=:[!&|?{};+-*%<>~^'.includes(previous))) {
      const s = ++i
      let inClass = false
      while (i < code.length && code[i] !== '\n' && (inClass || code[i] !== '/')) {
        if (code[i] === '\\') i++
        else if (code[i] === '[') inClass = true
        else if (code[i] === ']') inClass = false
        i++
      }
      blank(s, i)
      i++
      previous = 'v'
      continue
    }
    if (c === '{') braces++
    if (c === '}') {
      braces--
      if (resume.length > 0 && resume[resume.length - 1] === braces) {
        resume.pop()
        i++
        previous = templateText() ? '{' : 'v'
        continue
      }
    }
    if (!/\s/.test(c)) previous = /[\w$)\]]/.test(c) ? 'v' : c
    i++
  }
  return out.join('')
}

const CALL = /(?<![\w$.])(__require|require)(\.resolve)?\s*\(/g

/** Every `require(...)`, `__require(...)` and `.resolve(...)` call in code, with its argument text normalised. */
export function requireCalls (code) {
  const blanked = blankLiterals(code)
  const calls = []
  for (const match of blanked.matchAll(CALL)) {
    const open = match.index + match[0].length
    let depth = 1
    let end = open
    while (end < blanked.length && depth > 0) {
      if (blanked[end] === '(') depth++
      else if (blanked[end] === ')') depth--
      end++
    }
    const argument = code.slice(open, end - 1).replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim()
    const line = code.slice(0, match.index).split('\n').length
    calls.push({ text: `${match[1]}${match[2] ?? ''}(${argument})`, literal: /^(["'])[^"'\\]*\1$/.test(argument), line })
  }
  return calls
}

/**
 * The require() calls that may stay in the server bundle, each with the
 * reason it is safe. A `pattern` matches the call as esbuild prints it, with
 * its own renamed identifiers as `\w+`. A call not listed fails the build:
 * a `__require` with no literal name is one no bundler followed, and it
 * finds nothing unless something answers it at run time (install-require.js).
 */
export const DECLARED_REQUIRES = [
  {
    pattern: /^__require\(\w+\.resolve\(\w+\.join\(__dirname\d*, "\.\.", "defaults", "config\.js"\)\)\)$/,
    why: 'server/config.ts loads the defaults from the install tree the launcher writes; install-require.js hands it to the shim'
  },
  {
    pattern: /^__require\(configPath\)$/,
    why: 'server/config.ts loads the person\'s config.js from the server home; the shim loads it from the app\'s files'
  },
  {
    pattern: /^__require\(newLocal\)$/,
    why: 'server/command-line/start.ts loads the server by a name in a variable; install-require.js answers "../server" from the bundle'
  },
  {
    pattern: /^__require\(packagePath\)$/,
    why: 'server/plugins/packages/index.ts loads an installed theme or plugin package; none can be installed here (README.md)'
  },
  {
    pattern: /^__require\(adapters\[\w+\]\)$/,
    why: 'keyv, under got\'s response cache, loads a store named in its options; the server passes none'
  },
  {
    pattern: /^__require\.resolve\("yarn\/bin\/yarn\.js"\)$/,
    why: 'server/command-line/utils.ts finds yarn to install a package, which is refused by name (README.md)'
  },
  {
    pattern: /^__require\("(?:bufferutil|utf-8-validate)"\)$/,
    why: 'ws loads these optional native accelerators inside a try that ignores their absence, and the launcher sets WS_NO_BUFFER_UTIL and WS_NO_UTF_8_VALIDATE so it does not try'
  },
  {
    pattern: /^__require\(mod\)$/,
    why: 'express\'s View loads a template engine named by the app\'s "view engine" setting; the server sets none'
  },
  {
    pattern: /^__require\("dtrace-provider"\)$/,
    why: 'bunyan, under ldapjs, loads this optional native module inside a try that ignores its absence'
  }
]

/** What is wrong with the require() calls in `code`, given the calls a build may keep. */
export function checkRequires (code, declared = DECLARED_REQUIRES) {
  const problems = []
  const used = new Set()
  for (const call of requireCalls(code)) {
    const entry = declared.find((candidate) => candidate.pattern.test(call.text))
    if (entry === undefined) {
      problems.push(`server.mjs line ${call.line}: ${call.text} is left in the bundle for run time and is not on the declared list`)
    } else {
      used.add(entry)
    }
  }
  for (const entry of declared) {
    if (!used.has(entry)) problems.push(`the declared require ${String(entry.pattern)} no longer appears in the bundle -- remove it from DECLARED_REQUIRES`)
  }
  return problems
}

// --- what the bundle must and must not hold --------------------------------

/** The modules the server loads by a computed name: every `.ts` file of a directory, but its `index.ts`, which is imported by name. */
export function computedModules (dir, fileNames) {
  return fileNames.filter((name) => /\.ts$/.test(name) && !name.endsWith('.d.ts') && name !== 'index.ts').map((name) => `${dir}/${name}`)
}

/**
 * Inputs the bundle must hold and inputs it must not, from the metafile's
 * input paths (relative to the clone, posix). Each `required` is `{path, why}`,
 * counted from the clone by the caller, so a module upstream adds is required
 * without an edit; each `forbidden` is `{prefix, why}`.
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

/**
 * The builtins the shim has no module for, and who imports each, from the
 * texts of esbuild's errors. The plugin fails the build on each one; this is
 * the list a person reads to see what is left to build in the shim.
 */
export function unmappedBuiltins (errorTexts) {
  const found = new Map()
  for (const text of errorTexts) {
    const match = /^'([^']+)' is a Node builtin the Orivon shim has no module for \(imported from ([^)]+)\)/.exec(text)
    if (match === null) continue
    found.set(match[1], [...(found.get(match[1]) ?? []), match[2]])
  }
  return found
}

// --- the install tree ------------------------------------------------------

/** What the server reads with `fs` at start-up and per request; a client build that left any out is not one to serve. */
export const REQUIRED_INSTALL_FILES = [
  'public/index.html',
  'public/thelounge.webmanifest',
  'public/favicon.ico',
  'dist/defaults/config.js'
]

/** True for a file of upstream's public directory the install carries: not a source map, which only a debugger reads. */
export function isInstallFile (relative) {
  return !relative.endsWith('.map')
}

export function installFileProblems (files) {
  const problems = []
  const have = new Set(files)
  for (const path of REQUIRED_INSTALL_FILES) if (!have.has(path)) problems.push(`the install tree lacks ${path}`)
  if (!files.some((path) => path.startsWith('public/themes/') && path.endsWith('.css'))) {
    problems.push('the install tree holds no public/themes/*.css: the server lists that directory at start')
  }
  return problems
}

/** A stamp that changes when any file's name or bytes do; `entries` is `[name, bytes][]`. */
export function stampOf (entries) {
  const hash = createHash('sha256')
  for (const [name, bytes] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    hash.update(`${name}\0${String(bytes.length)}\0`)
    hash.update(bytes)
  }
  return hash.digest('hex').slice(0, 24)
}

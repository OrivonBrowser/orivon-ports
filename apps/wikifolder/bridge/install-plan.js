// The build's decisions about the install tree, as pure functions: which files
// of the clone the server reads at run time, what a complete tree holds, and
// how the files lie in the one pack the launcher unpacks. The server is
// upstream's own boot kernel, which finds its core, its plugins and its
// editions on the disk beside it, so the tree is a copy of those directories.
// esbuild.orivon.config.mjs does the I/O and throws on what these return;
// nothing here touches the disk, and each rule has a test that hands it a
// real violation (README.md, Design notes).

/** The directory under the app's virtual root that holds the install trees, one directory per stamp. */
export const INSTALL_DIR = 'wikifolder-install'

/** Where the wiki folder lives under the same root: the app's own files, the one place the user's tiddlers are kept. */
export const WIKI_DIR = 'wikifolder-wiki'

/** Where the launcher materialises the install tree whose stamp is `stamp`: a server keeps reading its own tree while a newer one is written beside it. */
export function installDirFor (stamp) {
  return `${INSTALL_DIR}/${stamp}`
}

/** The file at the top of the clone that upstream's boot kernel reads (`require("../package.json")`). */
const TOP_FILES = new Set(['package.json'])

/** Directories the server reads whole: the kernel, and the core with its server half. */
const WHOLE_DIRS = ['boot', 'core', 'core-server']

/** The editions `--init` can copy into a new wiki folder; the rest of `editions/` is upstream's documentation and test wikis. */
export const EDITIONS = ['server', 'empty']

/**
 * The plugin, theme and language directories a wiki made from the shipped
 * editions loads: `tiddlywiki.info` is the only thing that names them, and
 * the wiki folder's copy is not editable from the app, so any other
 * directory would be written and never read. `infoTexts` are the editions'
 * `tiddlywiki.info` files; the result is directory prefixes, each ending
 * in `/`, e.g. `plugins/tiddlywiki/tiddlyweb/`.
 */
export function editionDirs (infoTexts) {
  const dirs = new Set()
  for (const text of infoTexts) {
    const info = JSON.parse(text)
    for (const [key, dir] of [['plugins', 'plugins'], ['themes', 'themes'], ['languages', 'languages']]) {
      for (const name of Array.isArray(info[key]) ? info[key] : []) {
        if (typeof name !== 'string' || name === '' || name.split('/').includes('..') || name.startsWith('/')) {
          throw new Error(`an edition's tiddlywiki.info names ${String(name)} under "${key}", which is not a directory name`)
        }
        dirs.add(`${dir}/${name}/`)
      }
    }
  }
  return [...dirs].sort()
}

/** Whether the clone file `rel` (posix, relative to the clone) belongs to the install tree, given the directories `editionDirs` found. */
export function isInstallFile (rel, dirs) {
  if (rel.split('/').includes('..') || rel.startsWith('/')) return false
  if (TOP_FILES.has(rel)) return true
  const parts = rel.split('/')
  if (parts[0] === 'editions') return EDITIONS.includes(parts[1]) && parts.length > 2
  if (WHOLE_DIRS.includes(parts[0])) return parts.length > 1
  return dirs.some((dir) => rel.startsWith(dir))
}

/** What a tree must hold for the server to boot and for `--init server` to make a wiki: a path and what its absence would mean. */
const REQUIRED = [
  ['package.json', 'the boot kernel reads it for the version it checks'],
  ['boot/boot.js', 'the kernel'],
  ['boot/bootprefix.js', 'the kernel\'s first half'],
  ['core/plugin.info', 'the core plugin'],
  ['core-server/plugin.info', 'the server half of the core'],
  ['core-server/server/server.js', 'the HTTP server the listen command starts'],
  ['plugins/tiddlywiki/tiddlyweb/plugin.info', 'the browser side of saving to the server'],
  ['plugins/tiddlywiki/filesystem/plugin.info', 'the server side of saving tiddlers as files'],
  ['themes/tiddlywiki/vanilla/plugin.info', 'the default theme'],
  ['editions/server/tiddlywiki.info', 'the edition `--init server` copies']
]

/** Why the named files are not a complete install tree: one line per missing required path. Empty when it is. */
export function installFileProblems (names) {
  const present = new Set(names)
  return REQUIRED.filter(([path]) => !present.has(path)).map(([path, why]) => `${path} is missing: ${why}`)
}

/**
 * The names the pack may not hold. The pack is unpacked into the app's
 * files, so a name that climbs out, is absolute, or differs from another only
 * by case would write somewhere else or over a file on a case-insensitive disk.
 */
export function packNameProblems (names) {
  const problems = []
  const seen = new Map()
  for (const name of names) {
    if (name === '' || name.startsWith('/') || name.includes('\\') || name.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      problems.push(`${name} is not a relative path inside the install tree`)
      continue
    }
    const key = name.toLowerCase()
    if (seen.has(key)) problems.push(`${name} differs from ${seen.get(key)} only by case`)
    else seen.set(key, name)
  }
  return problems
}

/** `[name, bytes][]` as the pack's index and its one body: names in order, each file's size, the bytes end to end. */
export function packOf (files) {
  const index = files.map(([name, bytes]) => [name, bytes.length])
  const body = Buffer.concat(files.map(([, bytes]) => bytes))
  return { index, body }
}

/** The `vm` members the kernel calls that bridge/vm-stand-in.js answers, and the free name its global check reads through. */
const KERNEL_VM_MEMBERS = ['createContext', 'runInContext', 'runInThisContext']
const KERNEL_PROBE = 'Object.keys(__temp__)'

/**
 * Why boot/boot.js is not the kernel the stand-in was written for, from its
 * text: another `vm` member the shim refuses would be called, or the global
 * check no longer reads through `__temp__` and would report every module.
 * Empty when it is.
 */
export function kernelProblems (bootSource) {
  const problems = []
  const used = new Set([...bootSource.matchAll(/\bvm\.([A-Za-z]+)/g)].map((match) => match[1]))
  for (const member of used) {
    if (!KERNEL_VM_MEMBERS.includes(member)) problems.push(`boot/boot.js calls vm.${member}, which the stand-in does not answer`)
  }
  for (const member of ['createContext', 'runInContext']) {
    if (!used.has(member)) problems.push(`boot/boot.js no longer calls vm.${member}: the stand-in answers a call that is gone`)
  }
  if (!bootSource.includes(KERNEL_PROBE)) problems.push(`boot/boot.js no longer holds ${KERNEL_PROBE}: the global check the stand-in answers has changed, and would report every module`)
  return problems
}

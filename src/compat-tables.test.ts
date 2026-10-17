import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUILTIN_EXPORTS, codeSpans, electronKeys, ELECTRON_TABLE, loadCompat, mvpCandidate, NATIVE_TABLE, NODE_TABLE,
  parseElectronTable, parseNativeModules, parseNodeModules, parseRefusals, plain, splitRow, statusOf, trimTo
} from './compat-tables.ts'

const keys = (cell: string): string[] => electronKeys(cell).map((named) => named.key)

describe('statusOf and splitRow', () => {
  it('reads the four marks, and nothing for a ➖ or an unmarked cell', () => {
    expect(['✅ built', '⚠️ partial', '🚫 excluded', '❌ missing', '➖ n/a', 'plain'].map(statusOf))
      .toEqual(['works', 'limits', 'excluded', 'missing', undefined, undefined])
  })

  it('splits on a bar outside a code span and honours a backslash-escaped one', () => {
    expect(splitRow('| `a | b` | c \\| d | e |')).toEqual(['`a | b`', 'c | d', 'e'])
    expect(splitRow('not a row')).toBeUndefined()
  })

  it('strips a mark, a link and bold; trims at a word', () => {
    expect(plain('⚠️ **partial**: see [Table 3c](table-3c.md)')).toBe('partial: see Table 3c')
    expect(trimTo('one two three four', 10)).toBe('one two...')
    expect(trimTo('short', 10)).toBe('short')
  })

  it('finds code spans with their nesting, bold and colon position', () => {
    const spans = codeSpans('**`a`** (`B`, 5): `c`')
    expect(spans.map((span) => [span.text, span.bold, span.depth, span.afterColon])).toEqual([['a', true, 0, false], ['B', false, 1, false], ['c', false, 0, true]])
  })
})

// One case per name shape in Table 2b's first column; the real rows each comes from are in the comments.
describe('electronKeys', () => {
  it('takes a bold name as the export and ignores the classes in its parentheses', () => {
    expect(electronKeys('**`app`** (`App`, 115 members)')).toEqual([{ key: 'app', exportLevel: true }])
  })

  it('strips a call and its arguments', () => {
    expect(keys("`app.whenReady()`")).toEqual(['app.whenReady'])
    expect(keys("`app.getPath('userData')`")).toEqual(['app.getPath'])
    expect(keys('`app.getPath(name)` for the 16 other names')).toEqual(['app.getPath'])
  })

  it('lets undotted names inherit the object of the first dotted one', () => {
    expect(keys('`app.quit`, `exit`, `relaunch`')).toEqual(['app.quit', 'app.exit', 'app.relaunch'])
  })

  it('takes the first name as the object when a colon follows, across ";" parts', () => {
    expect(keys('`app` path and name: `getAppPath`, `getName`; `setPath`')).toEqual(['app.getAppPath', 'app.getName', 'app.setPath'])
  })

  it('files the members of a bold dotted name under it, and the name itself as the export', () => {
    expect(electronKeys('**`app.commandLine`** (`CommandLine`, 5 members): `appendSwitch`, `hasSwitch`')).toEqual([
      { key: 'app.commandLine', exportLevel: true },
      { key: 'app.commandLine.appendSwitch', exportLevel: false },
      { key: 'app.commandLine.hasSwitch', exportLevel: false }
    ])
  })

  it('shares members between objects joined by "and", and keeps a bare pair as two objects', () => {
    expect(keys('`ipcMain` and `ipcRenderer` members Electron inherits from `EventEmitter`: `emit`')).toEqual(expect.arrayContaining(['ipcMain.emit', 'ipcRenderer.emit']))
    expect(keys('`ipcMain` and `ipcRenderer`: return values and shared state')).toEqual(['ipcMain', 'ipcRenderer'])
  })

  it('does not take an event name for a member', () => {
    expect(keys('`app.on`, `once`, and the lifecycle events `ready`, `quit`')).toEqual(['app.on', 'app.once'])
    expect(keys('`app` events `second-instance`, `open-file`')).toEqual([])
  })

  it('takes a member that already carries its object, and ignores prose inside parentheses', () => {
    expect(keys("Electron detection through `process`: `process.type === 'renderer'`, `process.versions.electron`")).toEqual(['process.type', 'process.versions.electron'])
    expect(keys("Electron's additions to `process` (17 properties, 1 event): `type`, `versions.electron`; methods `crash`; event `loaded`"))
      .toEqual(['process.type', 'process.versions.electron', 'process.crash'])
  })

  it('names a package, a dotted global and a module specifier as objects of their own', () => {
    expect(keys('`@electron/remote` and `electron.remote` (absent from Electron 14)')).toEqual(['@electron/remote', 'electron.remote'])
    expect(keys('Subpath specifiers `electron/main` (39 exports) and `original-fs`')).toEqual(['electron/main', 'original-fs'])
  })

  it('treats the element after `<webview>` as its member', () => {
    expect(keys('`<webview>` attribute `src`')).toEqual(['<webview>.src'])
  })

  it('starts a new object at a ";" part that has its own colon', () => {
    expect(keys('`ipcRenderer.sendSync`, `postMessage`; `IpcRendererEvent` fields (2): `ports`'))
      .toEqual(['ipcRenderer.sendSync', 'ipcRenderer.postMessage', 'IpcRendererEvent.ports'])
  })

  it('takes the lower-case names in a bold export\'s parentheses as members, and leaves classes and counts alone', () => {
    expect(keys('**`desktopCapturer`** (`getSources`)')).toEqual(['desktopCapturer', 'desktopCapturer.getSources'])
    expect(keys('**`powerSaveBlocker`** (`start`, `stop`; event `x`)')).toEqual(['powerSaveBlocker', 'powerSaveBlocker.start', 'powerSaveBlocker.stop'])
    expect(keys('**`clipboard`** (7 members in Electron 44: `clear`, `has`)')).toEqual(['clipboard'])
    expect(keys('**`app`** (`App`, 115 members)')).toEqual(['app'])
  })

  it('gives a later part with no object of its own to the object before it, and drops the word static', () => {
    expect(keys('`Notification` constructor, `show`, `close`; static `isSupported`')).toEqual(expect.arrayContaining(['Notification.show', 'Notification.isSupported']))
  })

  it('keeps the string-literal argument a row is about', () => {
    expect(electronKeys("`app.getPath('userData')`")).toEqual([{ key: 'app.getPath', exportLevel: false, argument: 'userData' }])
    expect(electronKeys('`app.getPath(name)` for the 16 other names')).toEqual([{ key: 'app.getPath', exportLevel: false }])
  })

  it('names nothing for a row that is prose about names it does not own', () => {
    expect(keys('Names the 44 typings do not list: `readHTML`, `readImage`')).toEqual([])
  })
})

const TABLE_2B = [
  '# Tables 2b to 2d',
  '',
  '## Table 2b: the electron module, export by export',
  '',
  '| Electron API | What backs it, or what a port uses instead in a tab | This package | Used by |',
  '|---|---|---|---|',
  '| **`app`** (`App`, 115 members) | the manifest | ⚠️ partial: 4 of 115 | 3 |',
  '| `app.whenReady()` | resolves at once | ✅ built: works | 3 |',
  "| `app.getPath('userData')` | the virtual root | ⚠️ differs: not a host directory | 3 |",
  '| `app.getPath(name)` for the 16 other names | nothing | 🚫 excluded by design: refuses by name | 3 |',
  '| `app.quit`, `exit`, `relaunch` | `window.close()` | ❌ missing: reads `undefined` | 3 |',
  '| **`dialog`** (8 methods) | see below | ❌ missing: all 8 refuse by name | 3 |',
  '| `dialog.showOpenDialog` | `orivon.fs.userSelected` | ❌ missing: refuses, [see](x.md) | 3 |',
  '| `app` events `second-instance` | nothing | ⚠️ differs: throws | 3 |',
  '| `webPreferences.enableRemoteModule` | nothing | ➖ not applicable: Electron 44 has no such key | 3 |',
  '| `broken` | too few cells |',
  '',
  '## Table 2c: packages that wrap Electron',
  '',
  '| Package | What it needs | On Orivon |',
  '|---|---|---|',
  '| `electron-store` (11.0.2) | `ipcRenderer.sendSync` | ❌ missing: reads `undefined` |',
  '',
  '## Table 2d: web-ecosystem providers',
  '',
  '| Provider | Backed by | Status |',
  '|---|---|---|',
  '| `window.nostr` | nothing | ❌ missing: nobody injects it |'
].join('\n')

describe('parseElectronTable', () => {
  const { index, stats } = parseElectronTable(TABLE_2B, 'table-2b.md')

  it('indexes the rows of the 2b section only, with the statuses they carry', () => {
    expect(index.get('app.whenReady')?.[0]?.status).toBe('works')
    expect(index.get('app.quit')?.[0]).toMatchObject({ status: 'missing', note: 'missing: reads `undefined`', instead: '`window.close()`', table: 'table-2b.md' })
    expect(index.get('dialog.showOpenDialog')?.[0]?.note).toBe('missing: refuses, see')
    expect(index.has('window.nostr')).toBe(false)
    expect(index.has('electron-store')).toBe(false)
  })

  it('keeps both rows when two share a member, and marks the export row', () => {
    expect(index.get('app.getPath')?.map((row) => row.status)).toEqual(['limits', 'excluded'])
    expect(index.get('app')?.[0]?.exportLevel).toBe(true)
    expect(index.get('dialog')?.[0]?.exportLevel).toBe(true)
  })

  it('skips a malformed row, counts a row about events alone, and leaves a ➖ row out', () => {
    expect(stats).toMatchObject({ rows: 7, skipped: 1, unplaced: 1 })
    expect([...stats.statuses].sort()).toEqual(['excluded', 'limits', 'missing', 'works'])
    expect(index.has('webPreferences.enableRemoteModule')).toBe(false)
  })
})

describe('the other tables', () => {
  it('reads Node modules, several to a row, with the status in the second column', () => {
    const { index, stats } = parseNodeModules([
      '| Module | Status | Backed by | What is there, and what is absent | Used by |',
      '|---|:--:|---|---|---|',
      '| `fs` | ⚠️ partial | `fs.ts` | 52 of 104 exports | 9 |',
      '| `_http_agent`, `_http_client` | ❌ missing | nothing | deprecated internals | 0 |',
      '| `node:sqlite` | ✅ built | `sqlite` | all | 0 |',
      '| `oops` | no mark | x | y | 0 |'
    ].join('\n'), 'table-2a.md')
    expect(index.get('fs')?.[0]).toMatchObject({ status: 'limits', note: '52 of 104 exports', instead: '' })
    expect(index.get('_http_client')?.[0]?.status).toBe('missing')
    expect(index.get('node:sqlite')?.[0]?.status).toBe('works')
    expect(stats).toMatchObject({ rows: 3, skipped: 1 })
  })

  it('reads every table headed Library, and a trailing-/* name as a prefix group', () => {
    const { index, globs, stats } = parseNativeModules([
      '## Databases',
      '| Library | Why | Renderer answer | Verdict |',
      '|---|---|---|---|',
      '| `better-sqlite3`, `sqlite3` | local db | `node:sqlite` | ⚠️ limited to a forked child |',
      '## Cryptography',
      '| Library | Why | Renderer answer | Verdict |',
      '|---|---|---|---|',
      '| `@noble/*`, `openpgp` | crypto | pure JS | ✅ |',
      '| `keytar` | secrets | none | ❌ Blocked on a keyring adapter |'
    ].join('\n'), 'table-5.md')
    expect([...index.keys()].sort()).toEqual(['better-sqlite3', 'keytar', 'openpgp', 'sqlite3'])
    expect(index.get('sqlite3')?.[0]).toMatchObject({ status: 'limits', note: 'limited to a forked child', instead: '`node:sqlite`' })
    expect(globs.map((glob) => glob.prefix)).toEqual(['@noble/'])
    expect(stats.statuses).toEqual(expect.arrayContaining(['works', 'missing', 'limits']))
  })

  it('reads the module and the refused names off a generated file', () => {
    const refusals = parseRefusals([
      '// Generated (A287): a named export per Node `fs` member this shim does',
      "export const watch = refusingExport('watch', classify)",
      "export const chmod = refusingExport('chmod', classify)"
    ].join('\n'), 'src/shim/fs/generated/fs.ts')
    expect(refusals).toMatchObject({ module: 'fs', file: 'src/shim/fs/generated/fs.ts' })
    expect([...refusals?.names ?? []]).toEqual(['watch', 'chmod'])
    expect(parseRefusals('// something else', 'x.ts')).toBeUndefined()
  })
})

describe('loadCompat', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'orivon-compat-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('says what it could not read instead of throwing', async () => {
    const compat = await loadCompat(root)
    expect(compat.warnings.join('\n')).toContain(`${ELECTRON_TABLE} not found`)
    expect(compat.warnings.join('\n')).toContain(`${NODE_TABLE} not found`)
    expect(compat.warnings.join('\n')).toContain(`${NATIVE_TABLE} not found`)
    expect(compat.electron.size).toBe(0)
  })

  it('reads the exports Node has per module from the file mvp keeps', async () => {
    await mkdir(join(root, 'src/shim'), { recursive: true })
    await writeFile(join(root, BUILTIN_EXPORTS), JSON.stringify({ modules: { fs: { functions: ['readFile'], data: ['constants'] } } }))
    const compat = await loadCompat(root)
    expect([...compat.builtinExports.get('fs') ?? []].sort()).toEqual(['constants', 'readFile'])
  })

  it('warns when a table is there but nothing in it parses', async () => {
    await mkdir(join(root, 'docs/planning/compatibility'), { recursive: true })
    await writeFile(join(root, NODE_TABLE), '| Module | Status |\n|---|---|\n| `fs` | no mark |\n')
    const compat = await loadCompat(root)
    expect(compat.warnings.join('\n')).toContain('no rows could be read')
  })
})

describe('mvpCandidate', () => {
  it('prefers --mvp, then ORIVON_MVP_ROOT, then the sibling checkout', () => {
    expect(mvpCandidate('/a/mvp', { ORIVON_MVP_ROOT: '/b/mvp' })).toEqual({ path: '/a/mvp', from: '--mvp' })
    expect(mvpCandidate(undefined, { ORIVON_MVP_ROOT: '/b/mvp' })).toEqual({ path: '/b/mvp', from: 'ORIVON_MVP_ROOT' })
    expect(mvpCandidate(undefined, {}).path.endsWith('orivon-mvp')).toBe(true)
  })
})

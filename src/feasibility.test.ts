import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assess, formatFullRecon } from './feasibility.ts'
import { recon } from './recon.ts'

const ELECTRON = [
  '## Table 2b: the electron module, export by export',
  '| Electron API | What backs it | This package | Used by |',
  '|---|---|---|---|',
  '| **`dialog`** (8 methods) | see below | ❌ missing: all 8 refuse by name | 3 |',
  '| `dialog.showOpenDialog` | `orivon.fs.userSelected` | ❌ missing: refuses by name (`not-built`) | 3 |',
  '| **`Menu`** (12 members) | the shell owns the menu | 🚫 excluded by design: `new Menu()` refuses | 3 |',
  '| `shell.openExternal` | `window.open` | ⚠️ partial: opens the address | 3 |',
  '| `clipboard.writeText` | `navigator.clipboard` | ✅ built: works after a click | 3 |',
  '## Table 2c: packages that wrap Electron',
  '| Package | What it needs | On Orivon |',
  '|---|---|---|',
  '| `electron-store` (11) | `ipcRenderer.sendSync` | ❌ missing: reads `undefined` |'
].join('\n')

const NODE = [
  '| Module | Status | Backed by | What is there, and what is absent | Used by |',
  '|---|:--:|---|---|---|',
  '| `fs` | ⚠️ partial | `fs.ts` | 52 of 104 exports present | 9 |',
  '| `child_process` | ⚠️ partial | `cp.ts` | 9 exports | 9 |'
].join('\n')

const NATIVE = [
  '| Library | Why | Renderer answer | Verdict |',
  '|---|---|---|---|',
  '| `keytar` | secrets | none | ❌ Blocked on a keyring adapter over `orivon.secrets` |',
  '| `serialport` | serial | none | 🚫 Not built with `hid` |'
].join('\n')

const REFUSALS = [
  '// Generated (A287): a named export per Node `fs` member this shim does',
  "export const watch = refusingExport('watch', classify)"
].join('\n')

let clone: string
let mvp: string
const put = async (root: string, rel: string, text: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), text)
}

beforeEach(async () => {
  clone = await mkdtemp(join(tmpdir(), 'orivon-feas-clone-'))
  mvp = await mkdtemp(join(tmpdir(), 'orivon-feas-mvp-'))
  await put(mvp, 'docs/planning/compatibility/table-2b-electron.md', ELECTRON)
  await put(mvp, 'docs/planning/compatibility/table-2a-node-modules.md', NODE)
  await put(mvp, 'docs/planning/compatibility/table-5-native-modules.md', NATIVE)
  await put(mvp, 'src/shim/fs/generated/fs.ts', REFUSALS)
  // main only: Menu, powerMonitor, app, fs.watch, child_process, keytar; preload only: shell;
  // renderer only: clipboard, serialport; main and renderer both: dialog and fs.
  await put(clone, 'src/main/index.js', [
    "const { dialog, Menu, powerMonitor, app } = require('electron')",
    "const fs = require('fs')",
    "const { spawn } = require('child_process')",
    "require('keytar')",
    'dialog.showOpenDialog({}); Menu.setApplicationMenu(null); powerMonitor.on("x"); app.quit()',
    "fs.watch(p); spawn('ffmpeg', []); spawn(program)"
  ].join('\n'))
  await put(clone, 'src/preload/index.js', "const { shell, clipboard } = require('electron')\nshell.openExternal(u)")
  await put(clone, 'src/renderer/a.js', [
    "const { clipboard, dialog } = require('electron')",
    "const fs = require('fs')",
    "require('serialport')",
    'clipboard.writeText(t); dialog.showOpenDialog({}); fs.readFileSync(p); fetch("/x")'
  ].join('\n'))
  await put(clone, 'package.json', JSON.stringify({ dependencies: { keytar: '7', 'electron-store': '8', serialport: '1', lodash: '4' } }))
})
afterEach(async () => {
  await rm(clone, { recursive: true, force: true })
  await rm(mvp, { recursive: true, force: true })
})

describe('assess and formatFullRecon', () => {
  it('judges what runs in Orivon and lists main and preload uses as bridge hints', async () => {
    const report = await recon(clone)
    const feasibility = await assess(clone, report, { mvp })
    const text = formatFullRecon(report, clone, feasibility)

    expect(text.indexOf('# Port recon')).toBeLessThan(text.indexOf('## What Orivon can run'))
    const headings = [...text.matchAll(/^### (.+?) \(\d+\)$/gm)].map((m) => m[1])
    expect(headings).toEqual(['Missing in Orivon', 'Excluded by Orivon', 'Works with limits', 'Works today', 'Declared in package.json, never seen imported', 'Main and preload: dropped, the bridge stands in'])

    const section = (heading: string): string => text.split(`### ${heading}`)[1]?.split('\n### ')[0] ?? ''
    // renderer-only, and found in both main and renderer: judged
    expect(section('Missing in Orivon')).toContain('`dialog.showOpenDialog` -- 2 files, first src/renderer/a.js (main/renderer)')
    expect(section('Missing in Orivon')).toContain('[table-2b-electron.md:5]')
    expect(section('Missing in Orivon')).not.toContain('electron-store')
    expect(section('Declared in package.json, never seen imported')).toContain('`electron-store` -- declared in package.json (would be: Missing in Orivon)')
    expect(section('Excluded by Orivon')).toContain('`serialport` -- 1 file, first src/renderer/a.js (renderer)')
    expect(section('Works with limits')).toContain('`fs` -- 2 files')
    expect(section('Works with limits')).toContain('members used: readFileSync')
    expect(section('Works today')).toContain('`clipboard.writeText`')

    // main only, preload only, a package imported only in main: dropped, with the table's instead-text
    const dropped = section('Main and preload: dropped, the bridge stands in')
    for (const api of ['Menu', 'powerMonitor.on', 'app.quit', 'fs.watch', 'child_process', "spawn('ffmpeg')", 'keytar', 'shell.openExternal']) {
      expect(dropped).toContain(`\`${api}\` -- `)
    }
    expect(dropped).toContain('never run; the bridge re-creates only what the renderer calls')
    expect(dropped).toContain('instead: the shell owns the menu [table-2b-electron.md:6]')
    expect(dropped).toContain('instead: `window.open` [table-2b-electron.md:7]')
    expect(dropped).not.toContain('`dialog')
    for (const judged of ['Missing in Orivon', 'Excluded by Orivon', 'Works with limits', 'Works today']) {
      for (const api of ['Menu', 'powerMonitor.on', 'fs.watch', 'keytar', 'shell.openExternal']) expect(section(judged)).not.toContain(`\`${api}\``)
    }
    expect(text).not.toContain('lodash')
    expect(text).toContain('1 process start(s) take a computed program')
    expect(text).toContain('Static reading is a floor, never a total')
  })

  it('opens with one count line that leaves the dropped uses out', async () => {
    const report = await recon(clone)
    const feasibility = await assess(clone, report, { mvp })
    const text = formatFullRecon(report, clone, feasibility)
    expect(feasibility.counts).toEqual({ missing: 2, excluded: 1, unknown: 0, limits: 1, works: 1 })
    expect(feasibility.declaredCount).toBe(1)
    expect(feasibility.droppedCount).toBe(8)
    expect(text).toContain('5 uses in code that runs in Orivon: 2 missing, 1 excluded, 0 not in the tables, 1 with limits, 1 work. 8 more sit only in main or preload, which the port drops. 1 declared package was never seen imported.')
  })

  it('judges a server app\'s main and preload directories, which run', async () => {
    const server = await mkdtemp(join(tmpdir(), 'orivon-feas-server-'))
    try {
      await put(server, 'lib/main/server.js', "const fs = require('fs')\nfs.watch(p); process.platform; require('zlib').brotliDecompress(b)")
      await put(server, 'lib/preload/p.js', "require('fs').readFileSync(p)")
      const report = await recon(server)
      const feasibility = await assess(server, report, { mvp })
      expect(feasibility.droppedCount).toBe(0)
      expect(feasibility.verdicts.every((verdict) => verdict.runs)).toBe(true)
    } finally {
      await rm(server, { recursive: true, force: true })
    }
  })

  it('reads the row for the argument it saw, and both rows for a computed one', async () => {
    const rows = [
      "| `app.getPath('userData')` | the virtual root | ⚠️ differs: virtual | 3 |",
      '| `app.getPath(name)` for the 16 other names | nothing | 🚫 excluded by design: refuses | 3 |',
      '## Table 2c'
    ].join('\n')
    await put(mvp, 'docs/planning/compatibility/table-2b-electron.md', ELECTRON.replace('## Table 2c', rows))
    const status = async (source: string): Promise<string[]> => {
      const dir = await mkdtemp(join(tmpdir(), 'orivon-feas-args-'))
      try {
        await put(dir, 'src/renderer/a.js', `const { app } = require('electron')\n${source}`)
        const report = await recon(dir)
        const found = (await assess(dir, report, { mvp })).verdicts.find((verdict) => verdict.api === 'app.getPath')
        return (found?.rows ?? []).map((row) => row.status)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
    expect(await status("app.getPath('userData')")).toEqual(['limits'])
    expect(await status("app.getPath('home')")).toEqual(['excluded'])
    expect(await status('app.getPath(name)')).toEqual(['limits', 'excluded'])
    expect(await status("app.getPath('userData'); app.getPath('home')")).toEqual(['limits', 'excluded'])
  })

  it('keeps the recon report above it unchanged', async () => {
    const report = await recon(clone)
    const full = formatFullRecon(report, clone, await assess(clone, report, { mvp }))
    const { formatRecon } = await import('./recon.ts')
    expect(full.startsWith(formatRecon(report, clone))).toBe(true)
  })

  it('prints the usage and says what is needed when no mvp checkout is found', async () => {
    const report = await recon(clone)
    const feasibility = await assess(clone, report, { mvp: join(clone, 'nowhere') })
    const text = formatFullRecon(report, clone, feasibility)
    expect(feasibility.mvp.found).toBe(false)
    expect(text).toContain('No orivon-mvp checkout was found')
    expect(text).toContain('`ORIVON_MVP_ROOT`')
    expect(text).toContain('`--mvp <path>`')
    expect(text).toContain('`dialog.showOpenDialog`')
    expect(text).toContain('in code that runs in Orivon (no verdicts)')
    expect(text).not.toContain('### Missing in Orivon')
  })

  it('finds the checkout through ORIVON_MVP_ROOT, and --mvp wins over it', async () => {
    const report = await recon(clone)
    const viaEnv = await assess(clone, report, { env: { ORIVON_MVP_ROOT: mvp } })
    expect(viaEnv.mvp).toMatchObject({ found: true, from: 'ORIVON_MVP_ROOT' })
    const flagWins = await assess(clone, report, { mvp: join(clone, 'nowhere'), env: { ORIVON_MVP_ROOT: mvp } })
    expect(flagWins.mvp).toMatchObject({ found: false, from: '--mvp' })
  })

  it('is plain JSON a program can read', async () => {
    const report = await recon(clone)
    const feasibility = JSON.parse(JSON.stringify(await assess(clone, report, { mvp }))) as { counts: Record<string, number>; verdicts: { api: string; category: string }[] }
    expect(feasibility.counts['missing']).toBeGreaterThan(0)
    expect(feasibility.verdicts.find((verdict) => verdict.api === 'dialog.showOpenDialog')).toMatchObject({ category: 'missing', runs: true })
    expect(feasibility.verdicts.find((verdict) => verdict.api === 'Menu')).toMatchObject({ category: 'dropped', runs: false })
  })

  it('warns, and still reports, when a table has gone', async () => {
    await rm(join(mvp, 'docs/planning/compatibility/table-5-native-modules.md'))
    const report = await recon(clone)
    const text = formatFullRecon(report, clone, await assess(clone, report, { mvp }))
    expect(text).toContain('**Warning:**')
    expect(text).toContain('table-5-native-modules.md not found')
    expect(text).toContain('`dialog.showOpenDialog`')
  })
})

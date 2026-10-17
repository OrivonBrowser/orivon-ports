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
  await put(clone, 'src/main/index.js', [
    "const { dialog, Menu, shell, clipboard, powerMonitor } = require('electron')",
    "const fs = require('fs')",
    "const { spawn } = require('child_process')",
    'dialog.showOpenDialog({}); Menu.setApplicationMenu(null); shell.openExternal(u); clipboard.writeText(t)',
    "fs.watch(p); fs.readFileSync(p); spawn('ffmpeg', []); spawn(program)"
  ].join('\n'))
  await put(clone, 'src/renderer/a.js', 'fetch("/x")')
  await put(clone, 'package.json', JSON.stringify({ dependencies: { keytar: '7', 'electron-store': '8', serialport: '1', lodash: '4' } }))
})
afterEach(async () => {
  await rm(clone, { recursive: true, force: true })
  await rm(mvp, { recursive: true, force: true })
})

describe('assess and formatFullRecon', () => {
  it('judges what the clone uses against the tables, in the order a porter should read them', async () => {
    const report = await recon(clone)
    const feasibility = await assess(clone, report, { mvp })
    const text = formatFullRecon(report, clone, feasibility)

    expect(text.indexOf('# Port recon')).toBeLessThan(text.indexOf('## What Orivon can run'))
    const headings = [...text.matchAll(/^### (.+?) \(\d+\)$/gm)].map((m) => m[1])
    expect(headings).toEqual(['Missing in Orivon', 'Excluded by Orivon', "Not in Orivon's tables", 'Works with limits', 'Works today'])

    const section = (heading: string): string => text.split(`### ${heading}`)[1]?.split('\n### ')[0] ?? ''
    expect(section('Missing in Orivon')).toContain('`dialog.showOpenDialog` -- 1 file, first src/main/index.js (main)')
    expect(section('Missing in Orivon')).toContain('refuses by name (`not-built`)')
    expect(section('Missing in Orivon')).toContain('[table-2b-electron.md:5]')
    expect(section('Missing in Orivon')).toContain('`fs.watch`')
    expect(section('Missing in Orivon')).toContain('`keytar` -- declared in package.json')
    expect(section('Missing in Orivon')).toContain('`electron-store`')
    expect(section('Excluded by Orivon')).toContain('`Menu`')
    expect(section('Excluded by Orivon')).toContain('`serialport`')
    expect(section("Not in Orivon's tables")).toContain('`powerMonitor`')
    expect(section('Works with limits')).toContain('`shell.openExternal`')
    expect(section('Works with limits')).toContain("`spawn('ffmpeg')`")
    expect(section('Works with limits')).toContain('members used: readFileSync')
    expect(section('Works today')).toContain('`clipboard.writeText`')
    expect(text).not.toContain('lodash')
    expect(text).toContain('1 process start(s) take a computed program')
    expect(text).toContain('Static reading is a floor, never a total')
  })

  it('opens with one count line', async () => {
    const report = await recon(clone)
    const feasibility = await assess(clone, report, { mvp })
    const text = formatFullRecon(report, clone, feasibility)
    expect(feasibility.counts).toEqual({ missing: 5, excluded: 2, unknown: 1, limits: 4, works: 1 })
    expect(text).toContain('13 APIs, modules, packages and programs used: 5 missing, 2 excluded, 1 not in the tables, 4 with limits, 1 work.')
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
    expect(feasibility.verdicts.find((verdict) => verdict.api === 'dialog.showOpenDialog')?.category).toBe('missing')
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

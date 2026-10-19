import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { REPO_ROOT } from './paths.ts'

// The command line around recon: what it refuses, and what it only reports.
let clone: string
beforeAll(async () => {
  clone = await mkdtemp(join(tmpdir(), 'orivon-recon-cli-'))
  await mkdir(join(clone, 'src'), { recursive: true })
  await writeFile(join(clone, 'src/a.js'), "const fs = require('fs')\nfs.readFileSync(p)")
})
afterAll(async () => { await rm(clone, { recursive: true, force: true }) })

const run = (args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> =>
  new Promise((resolve) => {
    execFile(process.execPath, ['src/cli.ts', 'recon', ...args], { cwd: REPO_ROOT, env: { ...process.env, ORIVON_MVP_ROOT: '', ...env } }, (error, out, err) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, out, err })
    })
  })

describe('orivon-port recon suggestions', () => {
  let app: string
  beforeAll(async () => {
    app = await mkdtemp(join(tmpdir(), 'orivon-recon-suggest-'))
    await mkdir(join(app, 'src/preload'), { recursive: true })
    await mkdir(join(app, 'src/main'), { recursive: true })
    await mkdir(join(app, 'src/renderer'), { recursive: true })
    await writeFile(join(app, 'src/preload/index.js'),
      "contextBridge.exposeInMainWorld('api', { keepAwake: () => ipcRenderer.send('keep-awake'), mystery: () => ipcRenderer.send('mystery') })")
    await writeFile(join(app, 'src/main/index.js'),
      "import { ipcMain, powerSaveBlocker } from 'electron'\nipcMain.on('keep-awake', () => { powerSaveBlocker.start('prevent-display-sleep') })\nipcMain.on('mystery', () => { run() })")
    await writeFile(join(app, 'src/renderer/a.js'), 'window.api.keepAwake(); window.api.mystery()')
  })
  afterAll(async () => { await rm(app, { recursive: true, force: true }) })

  it('prints a suggestion with its evidence beside the members, and none where the handler says nothing', async () => {
    const result = await run([app], { ORIVON_MVP_ROOT: join(app, 'no-mvp') })
    expect(result.code).toBe(0)
    expect(result.out).toContain('## Suggested buckets')
    expect(result.out).toContain('- `keepAwake` -> **behaviours.wakeLock.acquire**')
    expect(result.out).toContain('send `keep-awake` -> src/main/index.js:2')
    expect(result.out).toContain('- `mystery` -> none')
  })

  it('carries the suggestions in --json, and a suggestion never replaces the unclassified names', async () => {
    const result = await run([app, '--json'], { ORIVON_MVP_ROOT: join(app, 'no-mvp') })
    const json = JSON.parse(result.out) as { suggestions: { suggested: number; members: { member: string; suggestion?: { behaviour: string } }[] }; members: string[] }
    expect(json.suggestions.suggested).toBe(1)
    expect(json.suggestions.members.find((entry) => entry.member === 'keepAwake')?.suggestion?.behaviour).toBe('wakeLock')
    expect(json.members).toEqual(['keepAwake', 'mystery'])
  })
})

describe('orivon-port recon', () => {
  it('exits 1 for a clone that is not a directory', async () => {
    const result = await run([join(clone, 'nowhere')])
    expect(result.code).toBe(1)
    expect(result.err).toContain('is not a directory')
  })

  it('exits 1 for --mvp with no value, or naming a path without the tables', async () => {
    const bare = await run([clone, '--mvp'])
    expect(bare.code).toBe(1)
    expect(bare.err).toContain('--mvp needs the path')
    const missing = await run([clone, '--mvp', join(clone, 'no-mvp')])
    expect(missing.code).toBe(1)
    expect(missing.err).toContain('no orivon-mvp compatibility tables')
  })

  it('still reports the usage when only the environment variable names a missing checkout', async () => {
    const result = await run([clone], { ORIVON_MVP_ROOT: join(clone, 'no-mvp') })
    expect(result.code).toBe(0)
    expect(result.out).toContain('No orivon-mvp checkout was found')
    expect(result.out).toContain('`fs.readFileSync`')
  })

  it('accepts a relative path to the clone', async () => {
    const result = await run([relative(REPO_ROOT, clone)], { ORIVON_MVP_ROOT: join(clone, 'no-mvp') })
    expect(result.code).toBe(0)
    expect(result.out).toContain('`fs.readFileSync`')
  })
})

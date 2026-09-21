import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatRecon, recon } from './recon.ts'

let clone: string
const write = async (rel: string, text: string): Promise<void> => {
  await mkdir(join(clone, rel, '..'), { recursive: true })
  await writeFile(join(clone, rel), text)
}

beforeEach(async () => {
  clone = await mkdtemp(join(tmpdir(), 'orivon-recon-'))
  await mkdir(join(clone, 'src/renderer'), { recursive: true })
  await mkdir(join(clone, 'src/preload'), { recursive: true })
  await mkdir(join(clone, 'src/main'), { recursive: true })
})
afterEach(async () => { await rm(clone, { recursive: true, force: true }) })

describe('recon', () => {
  it('counts named bridge members the renderer actually calls', async () => {
    await write('src/preload/index.js',
      "contextBridge.exposeInMainWorld('appApi', { getPath: () => ipcRenderer.invoke('get-path'), unused: () => {} })")
    await write('src/renderer/main.js', 'window.appApi.getPath(); window.appApi.setTitle("x")')
    await write('src/main/index.js', "ipcMain.handle('get-path', f); ipcMain.on('quit', f)")

    const report = await recon(clone)
    expect(report.bridgeNames).toEqual(['appApi'])
    expect(report.members).toEqual(['getPath', 'setTitle'])
    expect(report.ipcHandlers).toBe(2)
    expect(report.genericForwarder).toBe(false)
  })

  // The expensive shape: the preload's one member hides a surface as wide as
  // main's handler list, so the member count is a lie and the handler count is not.
  it('flags a generic forwarder', async () => {
    await write('src/preload/index.js',
      "contextBridge.exposeInMainWorld('ipc', { invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args) })")
    await write('src/renderer/main.js', 'window.ipc.invoke("a")')
    const report = await recon(clone)
    expect(report.genericForwarder).toBe(true)
    expect(formatRecon(report, clone)).toContain('Generic forwarder')
  })

  it('reports a renderer that touches no node builtin and no electron', async () => {
    await write('src/renderer/a.js', 'const r = await fetch("/x"); fetch("/y")')
    const report = await recon(clone)
    expect(report.nodeBuiltins).toEqual([])
    expect(report.electronImports).toEqual([])
    expect(report.fetchCalls).toBe(2)
    expect(formatRecon(report, clone)).toContain('families 1 and 2 never')
  })

  it('names the renderer files that do touch node or electron', async () => {
    await write('src/renderer/fsy.js', "import { readFile } from 'node:fs'")
    await write('src/renderer/elec.js', "import { ipcRenderer } from 'electron'")
    const report = await recon(clone)
    expect(report.nodeBuiltins).toEqual(['src/renderer/fsy.js'])
    expect(report.electronImports).toEqual(['src/renderer/elec.js'])
  })

  it('skips node_modules rather than reconning the dependency tree', async () => {
    await write('src/renderer/node_modules/dep/index.js', "import fs from 'node:fs'\nfetch(1)")
    const report = await recon(clone)
    expect(report.nodeBuiltins).toEqual([])
    expect(report.fetchCalls).toBe(0)
  })

  it('says so when it cannot find a preload, instead of reporting zero members', async () => {
    await rm(join(clone, 'src/preload'), { recursive: true })
    await write('src/renderer/a.js', 'x')
    expect(formatRecon(await recon(clone), clone)).toContain('No preload bridge found')
  })
})

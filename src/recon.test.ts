import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { declarationFrom, formatRecon, recon, writeDeclaration } from './recon.ts'

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

describe('--emit', () => {
  // A preload that exposes several objects, with a member name repeated across
  // two of them -- the shape a real multi-global port has.
  async function manyGlobals (): Promise<void> {
    await write('src/preload/index.js', [
      "contextBridge.exposeInMainWorld('apiChainStorage', {})",
      "contextBridge.exposeInMainWorld('apiAssetStorage', {})",
      "contextBridge.exposeInMainWorld('apiMpc', {})"
    ].join('\n'))
    await write('src/renderer/main.js', [
      'window.apiChainStorage.get(); window.apiChainStorage.save()',
      'window.apiAssetStorage.get()',
      'window.apiMpc.signBytes()'
    ].join('\n'))
  }

  it('writes the one-global form when the preload exposed one name', async () => {
    await write('src/preload/index.js', "contextBridge.exposeInMainWorld('appApi', {})")
    await write('src/renderer/main.js', 'window.appApi.getPath(); window.appApi.setTitle("x")')

    expect(declarationFrom(await recon(clone))).toEqual({ global: 'appApi', hand: [], unclassified: ['getPath', 'setTitle'] })
  })

  it('keeps each global\'s members apart, including a name two of them share', async () => {
    await manyGlobals()
    const report = await recon(clone)
    expect(report.membersByGlobal).toEqual({
      apiAssetStorage: ['get'],
      apiChainStorage: ['get', 'save'],
      apiMpc: ['signBytes']
    })
    expect(declarationFrom(report)).toEqual({
      globals: {
        apiAssetStorage: { hand: [], unclassified: ['get'] },
        apiChainStorage: { hand: [], unclassified: ['get', 'save'] },
        apiMpc: { hand: [], unclassified: ['signBytes'] }
      }
    })
  })

  it('writes just one global when asked for one', async () => {
    await manyGlobals()
    expect(declarationFrom(await recon(clone), 'apiMpc')).toEqual({ global: 'apiMpc', hand: [], unclassified: ['signBytes'] })
  })

  it('refuses a global this clone does not expose', async () => {
    await manyGlobals()
    const report = await recon(clone)
    expect(() => declarationFrom(report, 'apiNope')).toThrow(/not "apiNope"/)
  })

  // A fourteen-global app is bucketed a few globals at a time, so a second
  // pass must not undo the first.
  it('merges a second pass, leaving a global that has already been bucketed alone', async () => {
    await manyGlobals()
    const report = await recon(clone)
    const path = join(clone, 'members.json')

    await writeDeclaration(path, report)
    const bucketed = {
      globals: {
        apiMpc: { noop: { why: 'no second process', members: ['signBytes'] } },
        apiChainStorage: { hand: [], unclassified: ['get', 'save'] }
      }
    }
    await writeFile(path, JSON.stringify(bucketed))

    const kept = await writeDeclaration(path, report)
    expect(kept).toEqual(['apiMpc'])
    const written = JSON.parse(await readFile(path, 'utf8')) as { globals: Record<string, unknown> }
    expect(written.globals['apiMpc']).toEqual(bucketed.globals.apiMpc)
    expect(written.globals['apiChainStorage']).toEqual({ hand: [], unclassified: ['get', 'save'] })
    expect(Object.keys(written.globals).sort()).toEqual(['apiAssetStorage', 'apiChainStorage', 'apiMpc'])
  })
})

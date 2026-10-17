import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { scanClone } from './usage-scan.ts'

describe('scanClone', () => {
  let clone: string
  const put = async (rel: string, text: string): Promise<void> => {
    await mkdir(join(clone, rel, '..'), { recursive: true })
    await writeFile(join(clone, rel), text)
  }
  beforeEach(async () => { clone = await mkdtemp(join(tmpdir(), 'orivon-usage-')) })
  afterEach(async () => { await rm(clone, { recursive: true, force: true }) })

  it('counts files per use, tells main from renderer and leaves out tests and node_modules', async () => {
    await put('src/main/index.js', "const { app, dialog } = require('electron')\nconst fs = require('fs')\napp.quit(); fs.watch(x)")
    await put('src/main/other.js', "const { app } = require('electron')\napp.quit()")
    await put('src/renderer/a.js', "const fs = require('node:fs')\nfs.readFileSync(p)")
    await put('src/renderer/a.test.js', "const { app } = require('electron')\napp.relaunch()")
    await put('src/renderer/node_modules/dep/i.js', "require('electron').shell.beep()")
    const scan = await scanClone(clone, { main: 'src/main', renderer: 'src/renderer' })
    const quit = scan.electron.find((use) => use.api === 'app.quit')
    expect(quit).toMatchObject({ files: ['src/main/index.js', 'src/main/other.js'], roles: ['main'] })
    expect(scan.electron.some((use) => use.api === 'app.relaunch' || use.api === 'shell.beep')).toBe(false)
    expect(scan.node.find((use) => use.api === 'fs')).toMatchObject({ roles: ['main', 'renderer'] })
    expect(scan.testFilesSkipped).toBe(1)
  })

  it('scans the whole clone when no root was found', async () => {
    await put('lib/x.js', "require('electron').shell.openExternal(u)")
    const scan = await scanClone(clone, {})
    expect(scan.electron.map((use) => use.api)).toEqual(['shell.openExternal'])
    expect(scan.electron[0]?.roles).toEqual(['clone'])
  })

  it('finds main and preload in an Electron app by what a file imports, then by narrow names, and keeps build output out', async () => {
    await put('package.json', JSON.stringify({ devDependencies: { electron: '40' } }))
    await put('apps/desk/src/boot.ts', "require('electron').app.quit()")
    await put('apps/desk/src/main/index.ts', "require('os').homedir()")
    await put('electron/main.js', "require('os').hostname()")
    await put('apps/desk/src/webviewPreloader/dapp.ts', "require('os').arch()")
    await put('apps/desk/src/preload.ts', "require('os').cpus()")
    await put('apps/desk/src/views/main/Home.js', "require('os').uptime()")
    await put('apps/desk/src/utils/preloadImages.js', "require('os').tmpdir()")
    await put('apps/desk/src/ui/view.ts', "require('electron').shell.openExternal(u)")
    await put('apps/desk/dist-orivon/1.bundle.js', "require('electron').shell.beep()")
    await put('apps/desk/src/bundles/x.js', "require('electron').shell.beep()")
    await put('apps/desk/playwright.config.ts', "require('electron').shell.beep()")
    await put('.nx/cache/x.js', "require('electron').shell.beep()")
    const scan = await scanClone(clone, {})
    const roles = (api: string): readonly string[] | undefined => scan.node.find((use) => use.api === api)?.roles
    expect(scan.electronApp).toBe(true)
    expect(scan.electron.find((use) => use.api === 'app.quit')?.roles).toEqual(['main'])
    expect(roles('os.homedir')).toEqual(['main'])
    expect(roles('os.hostname')).toEqual(['main'])
    expect(roles('os.arch')).toEqual(['preload'])
    expect(roles('os.cpus')).toEqual(['preload'])
    expect(roles('os.uptime')).toEqual(['clone'])
    expect(roles('os.tmpdir')).toEqual(['clone'])
    expect(scan.electron.find((use) => use.api === 'shell.openExternal')?.roles).toEqual(['clone'])
    expect(scan.electron.some((use) => use.api === 'shell.beep')).toBe(false)
  })

  it('is not an Electron app until a manifest lists electron or a file imports it, so a server app\'s main and preload run', async () => {
    await put('lib/main/server.js', "const fs = require('fs')\nfs.watch(p); process.platform")
    await put('lib/preload/cache.js', "const fs = require('fs')\nfs.readFile(p)")
    const scan = await scanClone(clone, {}, new Set(['process.platform']))
    expect(scan.electronApp).toBe(false)
    expect(scan.node.find((use) => use.api === 'fs')?.roles).toEqual(['clone'])
    expect(scan.electron.find((use) => use.api === 'process.platform')?.roles).toEqual(['clone'])
  })

  it('reads main code outside the roots, and a file that names an Electron import', async () => {
    await put('electron/main.js', "const { app } = require('electron')\nrequire('electron-store')")
    await put('src/renderer/a.js', 'x')
    const scan = await scanClone(clone, { renderer: 'src/renderer' })
    expect(scan.imports.find((use) => use.api === 'electron-store')?.roles).toEqual(['main'])
    expect(scan.files).toBe(2)
  })

  it('names a running file first for a use that sits in both', async () => {
    await put('package.json', JSON.stringify({ dependencies: { electron: '40' } }))
    await put('src/main/a.js', "require('os').arch()")
    await put('src/renderer/z.js', "require('os').arch()")
    const scan = await scanClone(clone, { main: 'src/main', renderer: 'src/renderer' })
    expect(scan.node.find((use) => use.api === 'os.arch')).toMatchObject({ files: ['src/main/a.js', 'src/renderer/z.js'], first: 'src/renderer/z.js' })
  })

  it('finds a nested package.json when the clone is given as a relative path', async () => {
    await put('src/renderer/package.json', JSON.stringify({ dependencies: { sharp: '1' } }))
    await put('src/renderer/a.js', "require('sharp')")
    const scan = await scanClone(relative(process.cwd(), clone), { renderer: 'src/renderer' })
    expect(scan.dependencies).toEqual([{ name: 'sharp', from: 'src/renderer/package.json' }])
    expect(scan.imports.map((use) => use.api)).toEqual(['sharp'])
  })

  it('records the arguments an Electron member was called with', async () => {
    await put('src/a.js', "const { app } = require('electron')\napp.getPath('userData')")
    await put('src/b.js', "const { app } = require('electron')\napp.getPath(name)")
    const scan = await scanClone(clone, { main: 'src' })
    expect(scan.electron.find((use) => use.api === 'app.getPath')?.args).toEqual(['userData', null])
  })

  it('records where each package and spawned program is used', async () => {
    await put('src/main/a.js', "const { spawn } = require('child_process')\nrequire('keytar'); require('@scope/pkg/deep'); spawn('ffmpeg')")
    await put('src/renderer/b.js', "import x from 'lodash'\nimport y from './local.js'")
    const scan = await scanClone(clone, { main: 'src/main', renderer: 'src/renderer' })
    expect(scan.imports.map((use) => [use.api, use.roles])).toEqual([['@scope/pkg', ['main']], ['keytar', ['main']], ['lodash', ['renderer']]])
    expect(scan.spawns[0]).toMatchObject({ program: 'ffmpeg', roles: ['main'] })
  })

  it('lists the programs it can name and counts the ones it cannot', async () => {
    await put('src/a.js', "const { spawn } = require('child_process')\nspawn('ffmpeg'); spawn(cmd)")
    const scan = await scanClone(clone, { main: 'src' })
    expect(scan.spawns).toEqual([{ fn: 'spawn', program: 'ffmpeg', files: ['src/a.js'], roles: ['src'] }])
    expect(scan.computedSpawns).toBe(1)
  })

  it('reads dependencies and flags an installed native addon', async () => {
    await put('package.json', JSON.stringify({ dependencies: { keytar: '7', 'pure-js': '1', napi: '1' }, optionalDependencies: { fsevents: '2' }, devDependencies: { electron: '40' } }))
    await put('node_modules/keytar/binding.gyp', '{}')
    await put('node_modules/keytar/package.json', '{}')
    await put('node_modules/napi/package.json', JSON.stringify({ napi: { name: 'x' } }))
    await put('node_modules/pure-js/package.json', '{}')
    await put('src/a.js', 'x')
    const scan = await scanClone(clone, { main: 'src' })
    expect(scan.dependencies.map((dependency) => dependency.name).sort()).toEqual(['fsevents', 'keytar', 'napi', 'pure-js'])
    expect(scan.nativeAddons.map((dependency) => dependency.name).sort()).toEqual(['keytar', 'napi'])
  })
})

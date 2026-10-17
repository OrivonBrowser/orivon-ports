import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeModuleName, scanClone, scanSource } from './usage-scan.ts'

const electron = (source: string, processKeys: string[] = []): string[] => [...scanSource(source, { processKeys: new Set(processKeys) }).electron].sort()
const node = (source: string): string[] => [...scanSource(source).node].sort()

describe('Electron use', () => {
  it('reads a destructured require and the members read off each bound name', () => {
    const found = electron("const { app, dialog: d } = require('electron')\napp.getPath('x'); app.whenReady().then(go); d.showOpenDialog({})")
    expect(found).toEqual(['app', 'app.getPath', 'app.whenReady', 'dialog', 'dialog.showOpenDialog'])
  })

  it('reads named, default and namespace imports, and ignores a type import', () => {
    expect(electron("import { ipcRenderer, type IpcRendererEvent } from 'electron'\nipcRenderer.invoke('a')")).toEqual(['ipcRenderer', 'ipcRenderer.invoke'])
    expect(electron("import * as electron from 'electron'\nelectron.shell.openExternal(u); electron.app.quit()")).toEqual(['app.quit', 'shell.openExternal'])
    expect(electron("import electron from 'electron'\nelectron.clipboard.writeText('x')")).toEqual(['clipboard.writeText'])
    expect(electron("import type { Menu } from 'electron'\nMenu.buildFromTemplate([])")).toEqual([])
  })

  it('reads a namespace require and an inline one, three levels deep', () => {
    expect(electron("const electron = require('electron')\nelectron.session.defaultSession.cookies.set(c)")).toEqual(['session.defaultSession.cookies'])
    expect(electron("require('electron').shell.openExternal(u)")).toEqual(['shell.openExternal'])
  })

  it('follows an alias, a member bound by name and a window.require', () => {
    expect(electron("const { app: electronApp } = window.require('electron')\nelectronApp.quit()")).toEqual(['app', 'app.quit'])
    expect(electron("const shell = require('electron').shell\nshell.openPath(p)")).toEqual(['shell', 'shell.openPath'])
  })

  it('records @electron/remote, the subpaths and original-fs by name', () => {
    expect(electron("const remote = require('@electron/remote')\nconst { ipcMain } = require('electron/main')")).toEqual(['@electron/remote', 'electron/main', 'ipcMain'])
    expect(electron("import fs from 'original-fs'")).toEqual(['original-fs'])
  })

  it('reads process members only for names the Electron table has rows for', () => {
    const source = "if (process.platform === 'win32' && process.versions.electron && process.env.X) {}"
    expect(electron(source)).toEqual([])
    expect(electron(source, ['process.platform', 'process.versions.electron'])).toEqual(['process.platform', 'process.versions.electron'])
  })

  it('does not take a comment, a lookalike or a member of something else', () => {
    expect(electron("// const { app } = require('electron')\n* const { app } = require('electron')\nconst x = require('electronic')")).toEqual([])
    expect(electron("const { app } = require('electron')\nother.app.quit()")).toEqual(['app'])
  })
})

describe('Node use', () => {
  it('reads the module and the members of a namespace, a destructure and a node: import', () => {
    expect(node("const fs = require('fs')\nfs.readFileSync(a); fs.watch(b)")).toEqual(['fs', 'fs.readFileSync', 'fs.watch'])
    expect(node("import { join, resolve as r } from 'node:path'")).toEqual(['path', 'path.join', 'path.resolve'])
    expect(node("import * as os from 'node:os'\nos.homedir()")).toEqual(['os', 'os.homedir'])
    expect(node("const { readFile } = require('fs/promises')")).toEqual(['fs/promises', 'fs/promises.readFile'])
  })

  it('files fs.promises.X under fs/promises', () => {
    expect(node("const fs = require('fs')\nfs.promises.readFile(p)")).toEqual(['fs', 'fs/promises.readFile'])
  })

  it('reads an inline require, an import() and a side-effect import', () => {
    expect(node("const t = require('os').tmpdir()\nawait import('zlib')\nimport 'dns'")).toEqual(['dns', 'os', 'os.tmpdir', 'zlib'])
  })

  it('does not take a package that is not a Node module, or a bare name the app depends on', () => {
    expect(node("const x = require('lodash')\nconst fsx = require('fs-extra')")).toEqual([])
    expect([...scanSource("import { Buffer } from 'buffer'", { packages: new Set(['buffer']) }).node]).toEqual([])
    expect([...scanSource("import { Buffer } from 'node:buffer'", { packages: new Set(['buffer']) }).node]).toEqual(['buffer', 'buffer.Buffer'])
  })

  it('names Node modules by their own list', () => {
    expect(['fs', 'node:fs', 'fs/promises', 'node:sqlite', 'fs-extra', '_http_agent'].map(nodeModuleName)).toEqual(['fs', 'fs', 'fs/promises', 'sqlite', undefined, undefined])
  })
})

describe('programs a file starts', () => {
  const spawns = (source: string): unknown[] => scanSource(source).spawns.map((call) => [call.fn, call.program])

  it('lists the program of a literal first argument, per function', () => {
    expect(spawns("const { spawn, execFile } = require('child_process')\nspawn('ffmpeg', ['-i', a]); execFile(\"git\", ['status'])"))
      .toEqual([['spawn', 'ffmpeg'], ['execFile', 'git']])
    expect(spawns("import cp from 'node:child_process'\ncp.exec('git log --oneline'); cp.fork('./worker.js')")).toEqual([['exec', 'git'], ['fork', './worker.js']])
    expect(spawns("require('child_process').spawnSync('ls')")).toEqual([['spawnSync', 'ls']])
  })

  it('reports a computed first argument without a name, and ignores a spawn that is not child_process', () => {
    expect(spawns("const { spawn } = require('child_process')\nspawn(cmd, args); spawn(`${dir}/x`)")).toEqual([['spawn', undefined], ['spawn', undefined]])
    expect(spawns("const re = /a/; re.exec('abc'); spawn('x')")).toEqual([])
  })
})

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
    await put('lib/x.js', "require('electron').app.quit()")
    const scan = await scanClone(clone, {})
    expect(scan.scanned).toEqual(['.'])
    expect(scan.electron.map((use) => use.api)).toEqual(['app.quit'])
    expect(scan.electron[0]?.roles).toEqual(['clone'])
  })

  it('lists the programs it can name and counts the ones it cannot', async () => {
    await put('src/a.js', "const { spawn } = require('child_process')\nspawn('ffmpeg'); spawn(cmd)")
    const scan = await scanClone(clone, { main: 'src' })
    expect(scan.spawns).toEqual([{ fn: 'spawn', program: 'ffmpeg', files: ['src/a.js'] }])
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

import { describe, expect, it } from 'vitest'
import { nodeModuleName, scanSource } from './source-ast.ts'

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
    expect(electron("const electron = require('electron')\nelectron.session.defaultSession.cookies.set(c)")).toEqual(['session.defaultSession.cookies.set'])
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
    expect(electron("// const { app } = require('electron')\nconst x = require('electronic')")).toEqual([])
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
    expect([...scanSource("import { Buffer } from 'node:buffer'", { packages: new Set(['buffer']) }).node].sort()).toEqual(['buffer', 'buffer.Buffer'])
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


describe('what is code and what is not', () => {
  it('reads a require after a block comment, and ignores one inside a comment or a string', () => {
    expect(node("/* x */ const fs = require('fs')\nfs.watch(p)")).toEqual(['fs', 'fs.watch'])
    expect(node("/* const fs = require('fs') */\n// import os from 'os'\nconst a = 1 // import zlib from 'zlib'")).toEqual([])
    expect(node("const s = \"require('fs')\"; const t = `import os from 'os'`")).toEqual([])
  })

  it('does not take a URL or a template literal for a member read', () => {
    expect(electron("const { app } = require('electron')\nconst u = 'https://app.element.io/'; const t = `${app}.x app.element.io`")).toEqual(['app'])
    expect(electron("const { safeStorage } = require('electron')\nconst t = `price: safeStorage.$`")).toEqual(['safeStorage'])
  })

  it('reads nested destructuring, a binding off a binding, and await import()', () => {
    expect(electron("const { session: { defaultSession } } = require('electron')\ndefaultSession.clearCache()")).toEqual(['session.defaultSession', 'session.defaultSession.clearCache'])
    expect(electron("const electron = require('electron')\nconst { app } = electron\napp.quit()")).toEqual(['app', 'app.quit'])
    expect(electron("const { dialog } = await import('electron')\ndialog.showOpenDialog({})")).toEqual(['dialog', 'dialog.showOpenDialog'])
    expect(electron("import('electron').then((m) => m.app)")).toEqual([])
  })

  it('reads bracket access with a literal key, and ignores a computed one', () => {
    expect(electron("const e = require('electron')\ne['shell'].openExternal(u); e[name].x()")).toEqual(['shell.openExternal'])
  })

  it('reads TypeScript, JSX and the script blocks of a component', () => {
    expect([...scanSource("import { app } from 'electron'\nconst n: number = 1\nconst x = <div>{app.getName()}</div>", { file: 'a.tsx' }).electron].sort()).toEqual(['app', 'app.getName'])
    const vue = "<template><div>{{ fs.x }}</div></template>\n<script lang=\"ts\">\nimport fs from 'fs'\nfs.watch(p as string)\n</script>"
    expect([...scanSource(vue, { file: 'A.vue' }).node].sort()).toEqual(['fs', 'fs.watch'])
  })

  it('records the first argument of an Electron call, a literal or computed', () => {
    const uses = scanSource("const { app } = require('electron')\napp.getPath('userData'); app.getPath(name); app.quit()")
    expect([...uses.electronArgs.get('app.getPath') ?? []]).toEqual(['userData', null])
    expect(uses.electronArgs.has('app.quit')).toBe(false)
  })
})

describe('what a file says about its own role', () => {
  const role = (source: string): string | undefined => scanSource(source).hostRole
  it('is main for a main-process export taken directly from electron, preload for contextBridge', () => {
    expect(role("const { app } = require('electron')")).toBe('main')
    expect(role("import { Tray } from 'electron/main'")).toBe('main')
    expect(role("const { contextBridge, ipcRenderer } = require('electron')\ncontextBridge.exposeInMainWorld('a', {})")).toBe('preload')
    expect(role("const { ipcRenderer, shell } = require('electron')")).toBeUndefined()
  })

  it('does not take a main export read through @electron/remote', () => {
    expect(role("const { app } = require('@electron/remote')")).toBeUndefined()
    expect(role("const { app } = require('electron').remote")).toBeUndefined()
  })

  it('knows when a file imports electron itself', () => {
    expect(scanSource("require('@electron/remote')").importsElectron).toBe(true)
    expect(scanSource("require('electronic')").importsElectron).toBe(false)
    expect(scanSource('process.platform', { processKeys: new Set(['process.platform']) }).importsElectron).toBe(false)
  })
})

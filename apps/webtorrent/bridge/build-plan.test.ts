// The build's decisions, each gate handed the violation it exists to catch.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  answeredChannels, APP_ROOT, checkBundle, electronRendererDefines, ENTRY_FILE, FORBIDDEN_PREFIXES, ICON_LINK, installFiles, mainHtml, moduleScope,
  REFUSED_NATIVE, refusedNativeSource, REQUIRED_INPUTS, sentChannels, STAND_INS, stampOf, unansweredChannels
} from './build-plan.js'

describe('moduleScope', () => {
  it('declares the module\'s own __dirname and __filename in the install', () => {
    const out = moduleScope('module.exports = __dirname\n', 'build/config.js')
    expect(out).toBe(`var __dirname = "${APP_ROOT}/build", __filename = "${APP_ROOT}/build/config.js";module.exports = __dirname\n`)
    expect(new Function('module', `${out}; return module`)({}).exports).toBe(`${APP_ROOT}/build`)
  })

  it('keeps a "use strict" directive first, and closes one that has no semicolon', () => {
    const out = moduleScope("'use strict'\nvar a = __filename\n", 'build/x.js')
    expect(out.startsWith("'use strict';var __dirname")).toBe(true)
    expect(() => new Function(out)).not.toThrow()
  })

  it('keeps a hashbang first, and leaves a module that names neither alone', () => {
    expect(moduleScope('#!/usr/bin/env node\nconsole.log(__dirname)\n', 'bin/x.js').startsWith('#!/usr/bin/env node\nvar __dirname')).toBe(true)
    expect(moduleScope('module.exports = 1\n', 'a.js')).toBe('module.exports = 1\n')
  })

  it('gives a module at the clone\'s root the install root itself', () => {
    expect(moduleScope('x(__dirname)', 'index.js')).toContain(`var __dirname = "${APP_ROOT}"`)
  })
})

describe('mainHtml', () => {
  const upstream = '<head>\n    <link rel="stylesheet" href="main.css">\n  </head>\n  <body>\n    <div id=\'body\'></div>\n    <script>require(\'../build/renderer/main.js\')</script>\n  </body>'

  it('loads the bundle in place of the require(), the stylesheet under static/, and names the icon', () => {
    const html = mainHtml(upstream)
    expect(html).toContain(`<script src="${ENTRY_FILE}"></script>`)
    expect(html).toContain('href="static/main.css"')
    expect(html).toContain(ICON_LINK)
    expect(html).not.toContain('require(')
  })

  it('refuses a document whose shape changed, rather than serving it unloaded', () => {
    expect(() => mainHtml(upstream.replace("require('../build/renderer/main.js')", "require('../dist/main.js')"))).toThrow(/upstream changed its entry document/)
    expect(() => mainHtml(upstream.replace('main.css', 'app.css'))).toThrow(/main\.css/)
  })
})

describe('checkBundle', () => {
  const complete = REQUIRED_INPUTS.map(({ path }) => path)

  it('passes a bundle holding every required input and nothing refused', () => {
    expect(checkBundle('', complete)).toEqual([])
  })

  it('names a required input a browser field would have dropped', () => {
    const problems = checkBundle('', complete.filter((path) => path !== 'node_modules/bittorrent-dht/client.js'))
    expect(problems).toEqual([expect.stringMatching(/bittorrent-dht\/client\.js is missing.*DHT/)])
  })

  it('names a refused native addon or a stand-in that did not take effect', () => {
    expect(checkBundle('', [...complete, 'node_modules/utp-native/index.js'])).toEqual([expect.stringMatching(/utp-native.*native addon/)])
    expect(checkBundle('', [...complete, 'node_modules/chromecasts/index.js'])).toEqual([expect.stringMatching(/chromecasts.*stand-in/)])
  })

  it('forbids every stand-in\'s own package', () => {
    const forbidden = new Set(FORBIDDEN_PREFIXES.map(({ prefix }) => prefix))
    for (const name of Object.keys(STAND_INS).filter((name) => name !== 'electron')) expect(forbidden.has(`node_modules/${name}/`), name).toBe(true)
  })
})

describe('refusedNativeSource', () => {
  it('throws on load as a module that is not installed, which upstream\'s try/catch expects', () => {
    for (const name of REFUSED_NATIVE) {
      expect(() => new Function(refusedNativeSource(name))()).toThrow(expect.objectContaining({ code: 'MODULE_NOT_FOUND', message: expect.stringContaining(name) }))
    }
  })
})

describe('installFiles and stampOf', () => {
  it('lists the default torrents, their posters and the sounds, and nothing served by URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wtd-static-'))
    for (const name of ['sintel.torrent', 'sintel.jpg', 'main.css', 'loading.gif', 'about.html']) writeFileSync(join(dir, name), name)
    mkdirSync(join(dir, 'sound'))
    for (const name of ['add.wav', 'notes.txt']) writeFileSync(join(dir, 'sound', name), name)
    expect(await installFiles(dir)).toEqual(['sintel.jpg', 'sintel.torrent', 'sound/add.wav'])
  })

  it('changes with any file\'s name or bytes, and not otherwise', () => {
    const a = stampOf([['a.torrent', Buffer.from('1')]])
    expect(stampOf([['a.torrent', Buffer.from('1')]])).toBe(a)
    expect(stampOf([['a.torrent', Buffer.from('2')]])).not.toBe(a)
    expect(stampOf([['b.torrent', Buffer.from('1')]])).not.toBe(a)
  })
})

describe('the main-process channels', () => {
  const mainProcess = readFileSync(new URL('./main-process.js', import.meta.url), 'utf8')

  it('reads what the windows send, leaving the window-to-window wt-* relay out', () => {
    expect([...sentChannels(["ipcRenderer.send('setTitle', t)", "ipcRenderer.send('wt-start-server', h)", "ipcRenderer.send( 'openFiles')"])]).toEqual(['setTitle', 'openFiles'])
  })

  it('reads what main-process.js answers, its do-nothing list included', () => {
    const answered = answeredChannels(mainProcess)
    for (const channel of ['openFiles', 'setTitle', 'checkForExternalPlayer', 'ipcReady', 'setBadge']) expect(answered.has(channel), channel).toBe(true)
  })

  it('names a channel upstream sends that nobody answers', () => {
    expect(unansweredChannels(new Set(['setTitle', 'openNewThing']), answeredChannels(mainProcess))).toEqual(['openNewThing'])
  })
})

describe('electronRendererDefines', () => {
  it('says what upstream\'s Electron renderer reports: Node\'s and Electron\'s versions, a renderer, no browser flag, a development binary', () => {
    expect(electronRendererDefines('27.3.11')).toEqual({
      'process.versions.node': '"18.17.1"',
      'process.version': '"v18.17.1"',
      'process.versions.electron': '"27.3.11"',
      'process.type': '"renderer"',
      'process.browser': 'undefined',
      'process.execPath': '"/orivon/app/node_modules/electron/dist/electron"'
    })
  })

  it('makes upstream\'s production test read false on linux, so no telemetry or update check starts', () => {
    const execPath = JSON.parse(electronRendererDefines('27.3.11')['process.execPath'])
    // config.js: `process.platform === 'linux'` then `!/\/electron$/.test(process.execPath)`
    expect(!/\/electron$/.test(execPath)).toBe(false)
    // and Orivon's own empty execPath would have read true
    expect(!/\/electron$/.test('')).toBe(true)
  })

  it('refuses an Electron whose Node it does not know, rather than guessing', () => {
    expect(() => electronRendererDefines('33.0.0')).toThrow(/NODE_OF_ELECTRON/)
  })
})

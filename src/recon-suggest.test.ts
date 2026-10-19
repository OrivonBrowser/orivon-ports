import { describe, expect, it } from 'vitest'
import { constantReturn, stateOnly } from './ipc-main.ts'
import { Universe, parseSource } from './ipc-source.ts'
import { formatSuggestions, suggestFrom } from './recon-suggest.ts'
import type { MemberSuggestion } from './recon-suggest.ts'

// Small apps written out as text: a preload exposing one global, a main process
// answering it, and the constants file the channel names live in.
const CONSTANTS = "export const Ch = { START: 'start', STOP: 'stop', LOCALE: 'locale', PROXY: 'proxy', PLAY: 'play', NEW: 'new', RESTART: 'restart', PING: 'ping', SAVE: 'save', TICK: 'tick', ASK: 'ask', STATE: 'state' }\n"

function run (preload: string, main: string, extra: Record<string, string> = {}): Map<string, MemberSuggestion> {
  const universe = Universe.of({
    'src/constants.js': CONSTANTS,
    'src/preload/index.js': `import { ipcRenderer, webFrame, contextBridge } from 'electron'\nimport { Ch } from '../constants.js'\n${preload}`,
    'src/main/index.js': `import { app, BrowserWindow, ipcMain, powerSaveBlocker, session, dialog } from 'electron'\nimport { spawn } from 'node:child_process'\nimport fs from 'node:fs'\nimport { Ch } from '../constants.js'\n${main}`,
    ...extra
  })
  const report = suggestFrom(universe, 'src/preload', 'src/main')
  return new Map(report.members.map((member) => [member.member, member]))
}

const bucket = (entry: MemberSuggestion | undefined): string | undefined => {
  const s = entry?.suggestion
  return s === undefined ? undefined : [s.bucket, s.behaviour, s.role, s.refusal].filter((part) => part !== undefined).join('.')
}

const expose = (members: string): string => `contextBridge.exposeInMainWorld('api', {\n${members}\n})`

describe('suggestions read from the APIs a handler calls', () => {
  it('maps a power-save blocker pair to the wakeLock roles, following the constants file', () => {
    const found = run(
      expose("  start: () => ipcRenderer.send(Ch.START),\n  stop: () => ipcRenderer.send(Ch.STOP)"),
      [
        "ipcMain.on(Ch.START, () => { powerSaveBlocker.start('prevent-display-sleep') })",
        'function release () { powerSaveBlocker.stop(1) }',
        'ipcMain.on(Ch.STOP, () => { release() })'
      ].join('\n')
    )
    expect(bucket(found.get('start'))).toBe('behaviours.wakeLock.acquire')
    expect(bucket(found.get('stop'))).toBe('behaviours.wakeLock.release')
    expect(found.get('start')?.ipc).toEqual([{ kind: 'send', channel: 'start', resolved: true, handler: 'src/main/index.js:5' }])
    expect(found.get('stop')?.apis).toContain('powerSaveBlocker.stop (in release)')
  })

  it('reads a TypeScript enum, whose value is not its key', () => {
    const found = run(
      expose("  locale: () => ipcRenderer.invoke(Msg.LOCALE)"),
      "ipcMain.handle(Msg.LOCALE, () => app.getLocale())",
      { 'src/messages.ts': "enum Msg { LOCALE = 'get-locale' }\nexport default Msg" }
    )
    // `Msg` is declared in a file neither side imports here, so it is found by name across the app.
    expect(found.get('locale')?.ipc[0]).toMatchObject({ channel: 'get-locale', resolved: true })
    expect(bucket(found.get('locale'))).toBe('behaviours.locale')
  })

  it('suggests locale only when the handler does nothing else', () => {
    const found = run(
      expose("  locale: () => ipcRenderer.invoke(Ch.LOCALE),\n  ask: () => ipcRenderer.invoke(Ch.ASK)"),
      [
        'ipcMain.handle(Ch.LOCALE, () => app.getLocale())',
        "ipcMain.handle(Ch.ASK, () => { dialog.showMessageBox({}); return app.getLocale() })"
      ].join('\n')
    )
    expect(bucket(found.get('locale'))).toBe('behaviours.locale')
    expect(bucket(found.get('ask'))).toBeUndefined()
  })

  it('refuses proxy, window creation and a program launch with the reason the declaration uses', () => {
    const found = run(
      expose("  proxy: (u) => ipcRenderer.send(Ch.PROXY, u),\n  open: () => ipcRenderer.send(Ch.NEW),\n  play: (p) => ipcRenderer.send(Ch.PLAY, p)"),
      [
        'ipcMain.on(Ch.PROXY, (e, url) => { session.defaultSession.setProxy({ proxyRules: url }) })',
        'function createWindow () { return new BrowserWindow({ show: true }) }',
        'ipcMain.on(Ch.NEW, () => { createWindow() })',
        "ipcMain.on(Ch.PLAY, (e, p) => { spawn(p.executable, []) })"
      ].join('\n')
    )
    expect(found.get('proxy')?.suggestion).toMatchObject({ bucket: 'refused', refusal: 'shell-owned', detail: 'proxy configuration is browser-level' })
    expect(found.get('open')?.suggestion).toMatchObject({ bucket: 'refused', refusal: 'shell-owned' })
    expect(found.get('play')?.suggestion).toMatchObject({ bucket: 'refused', refusal: 'excluded' })
  })

  it('does not call a restart a refusal when the handler also writes a file', () => {
    const found = run(
      expose("  restart: () => ipcRenderer.send(Ch.RESTART),\n  save: () => ipcRenderer.send(Ch.SAVE)"),
      [
        'function relaunch () { app.relaunch(); app.quit() }',
        'ipcMain.on(Ch.RESTART, () => { relaunch() })',
        "ipcMain.on(Ch.SAVE, () => { fs.writeFileSync('flag', ''); relaunch() })"
      ].join('\n')
    )
    expect(found.get('restart')?.suggestion).toMatchObject({ bucket: 'refused', refusal: 'shell-owned' })
    expect(found.get('save')?.suggestion).toBeUndefined()
  })

  it('suggests nothing when two rules disagree about one handler', () => {
    const found = run(
      expose("  mixed: () => ipcRenderer.send(Ch.START)"),
      "ipcMain.on(Ch.START, () => { powerSaveBlocker.start('x'); spawn('tool', []) })"
    )
    expect(found.get('mixed')?.suggestion).toBeUndefined()
    expect(found.get('mixed')?.because).toContain('disagrees')
  })

  it('does not take a helper two calls away for what the handler does', () => {
    const found = run(
      expose("  start: () => ipcRenderer.send(Ch.START)"),
      ['function deep () { powerSaveBlocker.start("x") }', 'function mid () { deep() }', 'ipcMain.on(Ch.START, () => { mid() })'].join('\n')
    )
    expect(found.get('start')?.suggestion).toBeUndefined()
  })

  it('reads the preload member itself: zoom, and a script that toggles fullscreen or picture-in-picture', () => {
    const found = run(
      expose([
        '  zoom: (f) => { webFrame.setZoomFactor(f) },',
        "  fs: () => { webFrame.executeJavaScript('document.querySelector(\"video\").requestFullscreen()', true) },",
        "  pip: () => { webFrame.executeJavaScript('player.togglePiP()', true) },",
        "  other: () => { webFrame.executeJavaScript('document.title = 1', true) }"
      ].join('\n')),
      ''
    )
    expect(bucket(found.get('zoom'))).toBe('behaviours.zoom')
    expect(bucket(found.get('fs'))).toBe('behaviours.fullscreen')
    expect(bucket(found.get('pip'))).toBe('behaviours.pictureInPicture')
    expect(found.get('other')?.suggestion).toBeUndefined()
  })

  it('suggests a constant for a handler that only returns a literal, behind its guard, and none for a computed answer', () => {
    const found = run(
      expose("  flag: () => ipcRenderer.invoke(Ch.PING),\n  mode: () => ipcRenderer.invoke(Ch.ASK)"),
      [
        'ipcMain.handle(Ch.PING, (event) => { if (!event.senderFrame) return; return false })',
        'ipcMain.handle(Ch.ASK, () => process.platform === "linux")'
      ].join('\n')
    )
    expect(found.get('flag')?.suggestion).toEqual({ bucket: 'asyncConstants', value: false })
    expect(found.get('mode')?.suggestion).toBeUndefined()
  })

  it('suggests noop for a handler that only stores its argument, unless something reads the variable', () => {
    const found = run(
      expose("  remember: (v) => ipcRenderer.send(Ch.STATE, v),\n  used: (v) => ipcRenderer.send(Ch.TICK, v)"),
      [
        'let remembered',
        'let used',
        'ipcMain.on(Ch.STATE, (e, v) => { remembered = v })',
        'ipcMain.on(Ch.TICK, (e, v) => { used = v })',
        'function later () { return used }'
      ].join('\n')
    )
    expect(found.get('remember')?.suggestion).toMatchObject({ bucket: 'noop' })
    expect(found.get('used')?.suggestion).toBeUndefined()
  })

  it('notes an API that returns a host path without choosing a bucket for it', () => {
    const found = run(
      expose("  pick: () => ipcRenderer.invoke(Ch.ASK)"),
      "ipcMain.handle(Ch.ASK, async () => (await dialog.showOpenDialog({})).filePaths[0])"
    )
    expect(found.get('pick')?.suggestion).toBeUndefined()
    expect(found.get('pick')?.notes[0]).toContain('escape test')
  })

  it('suggests nothing for a member with an IPC call it cannot explain beside one it can', () => {
    const found = run(
      expose("  both: () => { ipcRenderer.send(Ch.START); ipcRenderer.send(Ch.TICK) }"),
      ["ipcMain.on(Ch.START, () => { powerSaveBlocker.start('x') })", 'ipcMain.on(Ch.TICK, () => { fs.readFileSync("a") })'].join('\n')
    )
    expect(found.get('both')?.suggestion).toBeUndefined()
  })

  it('suggests nothing for a channel passed as a variable, and says why', () => {
    const found = run(
      "contextBridge.exposeInMainWorld('api', { invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args) })",
      "ipcMain.handle(Ch.LOCALE, () => app.getLocale())"
    )
    expect(found.get('invoke')?.suggestion).toBeUndefined()
    expect(found.get('invoke')?.ipc[0]).toMatchObject({ channel: 'channel', resolved: false })
  })

  it('follows an exposed object that is imported from another file', () => {
    const found = run(
      "import { lang } from './lang.js'\ncontextBridge.exposeInMainWorld('lang', lang)",
      "ipcMain.handle(Ch.LOCALE, () => app.getLocale())",
      { 'src/preload/lang.js': "import { ipcRenderer } from 'electron'\nimport { Ch } from '../constants.js'\nexport const lang = { locale: () => ipcRenderer.invoke(Ch.LOCALE) }" }
    )
    expect(bucket(found.get('locale'))).toBe('behaviours.locale')
  })
})

describe('suggesting a listener', () => {
  const preload = expose("  onTick: (cb) => { ipcRenderer.on(Ch.TICK, (e, v) => cb(v)) }")

  it('suggests it when main never sends the channel', () => {
    const found = run(preload, "ipcMain.handle(Ch.LOCALE, () => 1)")
    expect(found.get('onTick')?.suggestion).toEqual({ bucket: 'listeners' })
    expect(found.get('onTick')?.because).toContain('never sends')
  })

  it('suggests it when every send is a second launch, a menu click or a send to the other windows', () => {
    const found = run(preload, [
      "app.on('second-instance', () => { BrowserWindow.getAllWindows()[0].webContents.send(Ch.TICK) })",
      "const menu = { label: 'x', click: () => notify() }",
      'function notify () { BrowserWindow.getAllWindows()[0].webContents.send(Ch.TICK) }',
      'function others (channel, event) { for (const w of BrowserWindow.getAllWindows().filter((x) => x.webContents.id !== event.sender.id)) w.webContents.send(channel) }',
      'ipcMain.handle(Ch.SAVE, (event) => { others(Ch.TICK, event) })'
    ].join('\n'))
    expect(found.get('onTick')?.suggestion).toEqual({ bucket: 'listeners' })
  })

  it('suggests nothing when one send comes from somewhere a one-window app reaches', () => {
    const found = run(preload, [
      "app.on('second-instance', () => { BrowserWindow.getAllWindows()[0].webContents.send(Ch.TICK) })",
      "app.on('ready', () => { BrowserWindow.getAllWindows()[0].webContents.send(Ch.TICK) })"
    ].join('\n'))
    expect(found.get('onTick')?.suggestion).toBeUndefined()
    expect(found.get('onTick')?.because).toContain('app event "ready"')
  })

  it('suggests nothing when a send names a channel that cannot be read', () => {
    const found = run(preload, 'function push (win, name) { win.webContents.send(name + "x") }')
    expect(found.get('onTick')?.suggestion).toBeUndefined()
    expect(found.get('onTick')?.because).toContain('could not read')
  })

  it('counts a send made while answering a refused member as inert', () => {
    const both = expose("  onTick: (cb) => { ipcRenderer.on(Ch.TICK, (e, v) => cb(v)) },\n  play: (p) => ipcRenderer.send(Ch.PLAY, p)")
    const found = run(both, [
      "ipcMain.on(Ch.PLAY, (event, p) => { spawn(p.exe, []); event.reply(Ch.TICK) })"
    ].join('\n'))
    expect(found.get('play')?.suggestion).toMatchObject({ bucket: 'refused', refusal: 'excluded' })
    expect(found.get('onTick')?.suggestion).toEqual({ bucket: 'listeners' })
  })
})

describe('what a handler looks like', () => {
  const fn = (code: string): { source: ReturnType<typeof parseSource>; node: Parameters<typeof stateOnly>[0]['node'] } => {
    const source = parseSource('a.js', code)
    const statement = source.tree.statements[0] as unknown as { declarationList?: { declarations: { initializer: unknown }[] } }
    return { source, node: statement.declarationList?.declarations[0]?.initializer as never }
  }

  it('reads a literal return through leading guards', () => {
    expect(constantReturn(fn('const h = (e) => { if (!e) return; if (e.x) { return } return { a: [1, -2, "s", null, true] } }').node)).toEqual({ value: { a: [1, -2, 's', null, true] } })
    expect(constantReturn(fn('const h = () => { log(); return 1 }').node)).toBeUndefined()
    expect(constantReturn(fn('const h = () => value').node)).toBeUndefined()
  })

  it('finds a store-only handler and refuses one with a call or a parameter as the target', () => {
    // A target that is the handler's own parameter stores nothing outside it.
    expect(stateOnly(fn('const h = (e, v) => { v = 1 }'))).toBeUndefined()
    const withState = parseSource('b.js', 'let kept\nconst h = (e, v) => { kept = v.x }')
    const init = (withState.tree.statements[1] as unknown as { declarationList: { declarations: { initializer: never }[] } }).declarationList.declarations[0]?.initializer
    expect(stateOnly({ source: withState, node: init as never })).toEqual(['kept'])
    const calls = parseSource('c.js', 'let kept\nconst h = (e, v) => { kept = load(v) }')
    const callInit = (calls.tree.statements[1] as unknown as { declarationList: { declarations: { initializer: never }[] } }).declarationList.declarations[0]?.initializer
    expect(stateOnly({ source: calls, node: callInit as never })).toBeUndefined()
  })
})

describe('the report', () => {
  it('prints each member with its evidence and says plainly when there is no suggestion', () => {
    const found = run(
      expose("  start: () => ipcRenderer.send(Ch.START),\n  other: () => ipcRenderer.send(Ch.TICK)"),
      "ipcMain.on(Ch.START, () => { powerSaveBlocker.start('x') })\nipcMain.on(Ch.TICK, () => { fs.readFileSync('a') })"
    )
    const text = formatSuggestions({ members: [...found.values()], suggested: 1, limits: ['a limit'] })
    expect(text).toContain('1 of 2 members have a suggestion')
    expect(text).toContain('- `start` -> **behaviours.wakeLock.acquire**')
    expect(text).toContain('- `other` -> none')
    expect(text).toContain('send `tick` -> src/main/index.js:')
    expect(text).toContain('Limits: a limit.')
  })

  it('reports an app with no preload and main as having nothing to trace', () => {
    expect(formatSuggestions({ members: [], suggested: 0, limits: ['no seam'] })).toContain('No member could be traced')
  })
})

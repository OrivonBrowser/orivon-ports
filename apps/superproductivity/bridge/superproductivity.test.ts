// What is Super Productivity's own about this bridge: the roster of 73 members
// of window.ea, the answer each bucket gives, the four hand-written members, and
// the one edit that is not a member -- the Electron token on the user agent.
//
// The behaviours themselves are the kit's (src/bridge/behaviours.test.ts) and so
// are the declaration's gates (src/bridge/declaration.test.ts). What runs below
// is the composed script, byte for byte what the browser is served.
import { describe, expect, it, vi } from 'vitest'
import { bridgeSourceFor, runBridge } from '../../../src/testing/bridge-harness.ts'
import type { LoadOptions } from '../../../src/testing/bridge-harness.ts'

const source = await bridgeSourceFor('superproductivity')

function freshBridge (options: LoadOptions = {}) {
  return runBridge(source, options)
}

// Every key of the object electron/preload.ts hands to contextBridge.exposeInMainWorld('ea', ...).
const MEMBERS = [
  'backupAppData', 'checkBackupAvailable', 'checkDirExists', 'commitPickedDirectory', 'consumeJiraApi',
  'consumePluginNodeExecutionApi', 'copyClipboardImageFile', 'deleteClipboardImage', 'discardPickedDirectory',
  'exit', 'fileSyncLoad', 'fileSyncRemove', 'fileSyncSave', 'flashFrame', 'getBackupPath', 'getClipboardFilePaths',
  'getClipboardImagePath', 'getDistChannel', 'getLocalRestApiToken', 'getPathForFile', 'getSyncFolderPath',
  'getUserDataPath', 'getZoomFactor', 'imageCacheGetDataUrl', 'imagePickAndImport', 'informAboutAppReady',
  'isAppleSilicon', 'isFlatpak', 'isGnomeDesktop', 'isGnomeWayland', 'isLinux', 'isMacOS', 'isSnap', 'listBackups',
  'listClipboardImages', 'loadBackupData', 'loadClipboardImage', 'lockScreen', 'on', 'onLocalRestApiRequest',
  'onPluginOAuthCb', 'onSwitchTask', 'openDevTools', 'openExternalUrl', 'openPath', 'pickDirectory',
  'pluginOAuthPrepare', 'pluginOAuthStart', 'readClipboardImage', 'registerGlobalShortcuts', 'regenerateLocalRestApiToken',
  'relaunch', 'reloadMainWin', 'saveClipboardImage', 'saveFileDialog', 'scheduleRegisterBeforeClose',
  'sendAppSettingsToElectron', 'sendLocalRestApiResponse', 'sendSettingsUpdate', 'setDoneRegisterBeforeClose',
  'setProgressBar', 'setZoomFactor', 'shareNative', 'showEmojiPanel', 'showFullScreenBlocker', 'showOpenDialog', 'showOrFocus',
  'shutdownNow', 'unscheduleRegisterBeforeClose', 'updateCurrentTask', 'updateTaskWidgetSettings',
  'updateTitleBarDarkMode', 'updateTodayTasks'
] as const

describe('the roster', () => {
  // A name dropped from members.json is a call site that gets `undefined is not a
  // function` deep inside the app's own bundle; a name added is a member upstream
  // never calls.
  it('installs exactly the 73 members upstream exposes, on window.ea', () => {
    const { bridge, sandbox } = freshBridge()
    expect(Object.keys(bridge).sort()).toEqual([...MEMBERS].sort())
    expect(MEMBERS).toHaveLength(73)
    expect(sandbox.window['ea']).toBe(bridge)
  })
})

describe('the answers upstream already handles on a first run', () => {
  it('reports no backup, no backups, no sync folder and nothing pending', async () => {
    const { bridge } = freshBridge()
    expect(await bridge.checkBackupAvailable()).toBe(false)
    expect(await bridge.listBackups()).toEqual([])
    expect(await bridge.getSyncFolderPath()).toBeNull()
    expect(await bridge.commitPickedDirectory()).toBeNull()
    // The caller chains .catch() on the result, so undefined would throw.
    expect(typeof bridge.discardPickedDirectory().then).toBe('function')
    expect(await bridge.backupAppData({ data: {}, maxBackupFiles: 10 })).toBeNull()
  })

  it('reports no clipboard file, no clipboard image and no cached background image', async () => {
    const { bridge } = freshBridge()
    expect(await bridge.getClipboardFilePaths()).toEqual([])
    expect(await bridge.readClipboardImage('/x')).toBeNull()
    expect(await bridge.copyClipboardImageFile('/x', '/y')).toBeNull()
    expect(await bridge.getClipboardImagePath('/x', 'id')).toBeNull()
    expect(await bridge.imageCacheGetDataUrl('id')).toBeNull()
    expect(bridge.getPathForFile({})).toBeNull()
  })

  it('reports no Jira API and no plugin Node API, which the renderer treats as unavailable', () => {
    const { bridge } = freshBridge()
    expect(bridge.consumeJiraApi()).toBeNull()
    expect(bridge.consumePluginNodeExecutionApi()).toBeNull()
  })

  it('reports the platform as a browser tab on no store channel', () => {
    const { bridge } = freshBridge()
    expect(bridge.getDistChannel()).toBeNull()
    for (const name of ['isGnomeDesktop', 'isGnomeWayland', 'isMacOS', 'isAppleSilicon', 'isSnap', 'isFlatpak']) {
      expect(bridge[name](), name).toBe(false)
    }
  })

  it('isLinux follows the page platform', () => {
    expect(freshBridge({ navigator: { platform: 'Linux x86_64' } as never }).bridge.isLinux()).toBe(true)
    expect(freshBridge({ navigator: { platform: 'Win32' } as never }).bridge.isLinux()).toBe(false)
    expect(freshBridge({ navigator: { userAgentData: { platform: 'Linux' }, platform: 'Win32' } as never }).bridge.isLinux()).toBe(true)
  })
})

describe('inert members', () => {
  it.each(['onSwitchTask', 'onPluginOAuthCb', 'onLocalRestApiRequest'])('%s records the callback and never calls it', (name) => {
    const { bridge, recordedListeners } = freshBridge()
    const callback = vi.fn()
    bridge[name](callback)
    expect(recordedListeners[name]).toBe(callback)
    expect(callback).not.toHaveBeenCalled()
  })

  it.each([
    'on', 'informAboutAppReady', 'flashFrame', 'showOrFocus', 'scheduleRegisterBeforeClose', 'unscheduleRegisterBeforeClose',
    'setDoneRegisterBeforeClose', 'setProgressBar', 'sendAppSettingsToElectron', 'sendSettingsUpdate',
    'updateTaskWidgetSettings', 'updateTitleBarDarkMode', 'registerGlobalShortcuts', 'showFullScreenBlocker',
    'updateCurrentTask', 'updateTodayTasks', 'showEmojiPanel', 'sendLocalRestApiResponse', 'openDevTools'
  ])('%s accepts its arguments and answers nothing', (name) => {
    const { bridge } = freshBridge()
    const listener = vi.fn()
    expect(bridge[name]('CHANNEL', listener)).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('refused by name', () => {
  const cases: ReadonlyArray<[string, string]> = [
    ['relaunch', 'shell-owned'], ['exit', 'shell-owned'], ['saveFileDialog', 'shell-owned'],
    ['shutdownNow', 'excluded'], ['lockScreen', 'excluded'], ['openPath', 'excluded'], ['shareNative', 'excluded'],
    ['showOpenDialog', 'excluded'], ['getUserDataPath', 'excluded'],
    ['loadBackupData', 'not-built'], ['fileSyncSave', 'not-built'], ['fileSyncLoad', 'not-built'],
    ['fileSyncRemove', 'not-built'], ['checkDirExists', 'not-built'], ['pickDirectory', 'not-built'],
    ['imagePickAndImport', 'not-built'], ['saveClipboardImage', 'not-built'], ['loadClipboardImage', 'not-built'],
    ['deleteClipboardImage', 'not-built'], ['listClipboardImages', 'not-built'], ['pluginOAuthPrepare', 'not-built'],
    ['pluginOAuthStart', 'not-built'], ['getLocalRestApiToken', 'not-built'], ['regenerateLocalRestApiToken', 'not-built']
  ]

  // The members the preload implements with ipcRenderer.invoke return a promise there, so the refusal is a
  // rejection: a caller that is not inside an async function has no try/catch to turn a throw into one.
  const ASYNC = new Set([
    'saveFileDialog', 'shareNative', 'showOpenDialog', 'getUserDataPath', 'loadBackupData', 'fileSyncSave', 'fileSyncLoad',
    'fileSyncRemove', 'checkDirExists', 'pickDirectory', 'imagePickAndImport', 'saveClipboardImage', 'loadClipboardImage',
    'deleteClipboardImage', 'listClipboardImages', 'pluginOAuthPrepare', 'getLocalRestApiToken', 'regenerateLocalRestApiToken'
  ])

  it.each(cases)('%s refuses with OrivonBridgeError, reason %s, and names the global', async (name, reason) => {
    const { bridge } = freshBridge()
    let outcome: unknown
    if (ASYNC.has(name)) {
      let returned: unknown
      expect(() => { returned = bridge[name]() }, name).not.toThrow()
      try { await returned } catch (error) { outcome = error }
    } else {
      try { bridge[name]() } catch (error) { outcome = error }
    }
    expect(outcome, name).toMatchObject({ name: 'OrivonBridgeError', reason, member: name, owner: 'ea' })
    expect((outcome as Error).message).toContain(`ea.${name} is unavailable`)
  })
})

describe('the members that carry a decision', () => {
  it('getBackupPath never answers, so the settings page adds no backup section and logs no unhandled rejection', async () => {
    const { bridge } = freshBridge()
    const pending = bridge.getBackupPath()
    expect(typeof pending.then).toBe('function')
    const winner = await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 20, 'still pending'))])
    expect(winner).toBe('still pending')
  })

  it('setZoomFactor and getZoomFactor agree, and an unset zoom is 1', () => {
    const { bridge } = freshBridge()
    expect(bridge.getZoomFactor()).toBe(1)
    bridge.setZoomFactor(1.25)
    expect(bridge.getZoomFactor()).toBe(1.25)
  })

  it('reloadMainWin reloads the page', () => {
    const reload = vi.fn()
    const { bridge, sandbox } = freshBridge()
    sandbox.window['location'] = { reload }
    bridge.reloadMainWin()
    expect(reload).toHaveBeenCalledOnce()
  })

  describe('openExternalUrl', () => {
    function opened (url: unknown) {
      const open = vi.fn()
      const { bridge, sandbox } = freshBridge()
      sandbox.window['open'] = open
      bridge.openExternalUrl(url)
      return open
    }

    it.each(['https://example.org/a?b=1', 'http://example.org/', 'mailto:someone@example.org'])('opens %s in a new tab without an opener', (url) => {
      expect(opened(url)).toHaveBeenCalledWith(new URL(url).href, '_blank', 'noopener,noreferrer')
    })

    it.each([
      'javascript:alert(1)', 'file:///etc/passwd', 'obsidian://open?vault=x', 'data:text/html,hi', '//host/share', 'not a url', '', undefined, null, 42
    ])('does not open %s', (url) => {
      expect(opened(url)).not.toHaveBeenCalled()
    })
  })
})

describe('the Electron token on the user agent', () => {
  const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

  it('is added inside Orivon, so the renderer takes its desktop branches', () => {
    const { sandbox } = freshBridge({ orivon: {}, navigator: { userAgent: CHROME } as never })
    const agent = (sandbox.navigator as unknown as { userAgent: string }).userAgent
    expect(agent.startsWith(CHROME)).toBe(true)
    // The exact test upstream's app.constants.ts runs.
    expect(agent.toLowerCase().indexOf(' electron/') > -1).toBe(true)
  })

  it('is not added in another browser, where window.ea has no Orivon behind it', () => {
    const { sandbox } = freshBridge({ navigator: { userAgent: CHROME } as never })
    expect((sandbox.navigator as unknown as { userAgent: string }).userAgent).toBe(CHROME)
  })

  it('is not added twice to a user agent that already carries it', () => {
    const real = `${CHROME} Electron/44.0.0`
    const { sandbox } = freshBridge({ orivon: {}, navigator: { userAgent: real } as never })
    expect((sandbox.navigator as unknown as { userAgent: string }).userAgent).toBe(real)
  })
})

describe('keeping a second tab out', () => {
  type Grant = (lock: object | null) => unknown
  function withLocks () {
    const requests: Array<{ name: string, options: unknown, callback: Grant }> = []
    const locks = { request: (name: string, options: unknown, callback: Grant) => { requests.push({ name, options, callback }) } }
    return { locks, requests }
  }

  it('takes one Web Lock when it runs inside Orivon, and holds it for the life of the page', () => {
    const { locks, requests } = withLocks()
    freshBridge({ orivon: {}, navigator: { locks } as never })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.options).toEqual({ ifAvailable: true })
    const held = requests[0]?.callback({})
    // A promise that never settles: the lock is held until the document goes. (Not instanceof: the bridge runs in another realm.)
    expect(typeof (held as { then: unknown }).then).toBe('function')
  })

  it('sends a tab that finds the lock taken to the static page, never to the app', () => {
    const { locks, requests } = withLocks()
    const replace = vi.fn()
    const { sandbox } = freshBridge({ orivon: {}, navigator: { locks } as never, document: { baseURI: 'http://127.0.0.1:8883/' } })
    sandbox.window['location'] = { replace }
    expect(requests[0]?.callback(null)).toBeUndefined()
    expect(replace).toHaveBeenCalledWith('http://127.0.0.1:8883/orivon/already-open.html')
  })

  it('asks for nothing in another browser, or where Web Locks do not exist', () => {
    const { locks, requests } = withLocks()
    freshBridge({ navigator: { locks } as never })
    expect(requests).toHaveLength(0)
    expect(() => freshBridge({ orivon: {} })).not.toThrow()
  })
})

describe('the manifest', () => {
  it('asks for one thing: to connect over https to any public site', async () => {
    const { readFile } = await import('node:fs/promises')
    const manifest = JSON.parse(await readFile(new URL('../orivon.json', import.meta.url), 'utf8')) as { capabilities: unknown }
    expect(manifest.capabilities).toEqual({ net: { https: { connect: ['*:*'] } } })
  })
})

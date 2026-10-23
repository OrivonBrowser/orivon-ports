// The composed bridge, byte for byte what the browser is served, in a fresh realm per test: the
// roster of upstream's `window.Actual` (packages/desktop-electron/preload.ts at the pin), how each
// member is answered, and that the ones that reach the backend do so through
// window.__orivonActualBackend and say so by name when it is missing.
import { describe, expect, it, vi } from 'vitest'
import { bridgeSourceFor, runBridge } from '../../../src/testing/bridge-harness.ts'
import { ACTUAL_VERSION } from './plan.js'

const source = await bridgeSourceFor('actualbudget')

// Every member upstream's preload exposes (23), all on window.Actual.
const MEMBERS: readonly string[] = [
  'IS_DEV', 'ACTUAL_VERSION', 'logToTerminal', 'ipcConnect', 'startSyncServer', 'stopSyncServer', 'isSyncServerRunning', 'startOAuthServer',
  'relaunch', 'restartElectronServer', 'openFileDialog', 'saveFile', 'openURLInBrowser', 'openInFileManager', 'onEventFromMain',
  'isUpdateReadyForDownload', 'waitForUpdateReadyForDownload', 'getServerSocket', 'setTheme', 'moveBudgetDirectory', 'setDocumentDir',
  'reload', 'applyAppUpdate'
]

const REFUSED = ['startSyncServer', 'stopSyncServer', 'startOAuthServer', 'openInFileManager', 'moveBudgetDirectory', 'setDocumentDir', 'reload', 'applyAppUpdate']

function backendFake () {
  return {
    listen: vi.fn(),
    post: vi.fn(),
    restart: vi.fn(),
    openFileDialog: vi.fn(async () => ['/orivon/app/actual-imports/x/a.zip']),
    saveFile: vi.fn(async () => {})
  }
}

function load (backend: unknown = backendFake(), extra: Record<string, unknown> = {}) {
  const loaded = runBridge(source)
  loaded.sandbox.window['__orivonActualBackend'] = backend
  return { ...loaded, backend: backend as ReturnType<typeof backendFake>, extra }
}

describe('the roster', () => {
  it('installs exactly the members upstream\'s preload exposes, on window.Actual', () => {
    const { bridge, sandbox } = runBridge(source)
    expect(Object.keys(bridge).sort()).toEqual([...MEMBERS].sort())
    expect(sandbox.window['Actual']).toBe(bridge)
  })

  it('answers the version of the release it is built from', () => {
    expect(runBridge(source).bridge['ACTUAL_VERSION']).toBe(ACTUAL_VERSION)
    expect(runBridge(source).bridge['IS_DEV']).toBe(false)
  })
})

describe('the members upstream\'s desktop preload answers with a constant', () => {
  it('says no update is waiting, and nothing is ever waited for', async () => {
    const { bridge } = runBridge(source)
    expect(bridge['isUpdateReadyForDownload']()).toBe(false)
    let settled = false
    void bridge['waitForUpdateReadyForDownload']().then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(settled).toBe(false)
  })

  it('has no worker socket and no embedded sync server running', async () => {
    const { bridge } = runBridge(source)
    expect(await bridge['getServerSocket']()).toBeNull()
    expect(await bridge['isSyncServerRunning']()).toBe(false)
  })

  it('takes a theme and a menu listener and does nothing with them', () => {
    const { bridge } = runBridge(source)
    expect(bridge['setTheme']('dark')).toBeUndefined()
    expect(bridge['onEventFromMain']('undo', () => {})).toBeUndefined()
  })
})

describe('the refused members', () => {
  it.each(REFUSED)('%s throws a named error with a reason, never an undefined call', (name) => {
    const { bridge, internals } = runBridge(source)
    let thrown: unknown
    try { bridge[name]() } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(internals.BridgeError as never)
    expect((thrown as { member: string }).member).toBe(name)
    expect((thrown as { owner: string }).owner).toBe('Actual')
    expect(['not-built', 'shell-owned']).toContain((thrown as { reason: string }).reason)
  })
})

describe('ipcConnect', () => {
  it('gives the callback an on and an emit that reach the backend: the renderer\'s message is what is sent, not the channel name', () => {
    const { bridge, backend } = load()
    let client: { on: (name: string, handler: () => void) => void, emit: (name: string, data: unknown) => void } | undefined
    bridge['ipcConnect']((c: typeof client) => { client = c })
    const handler = () => {}
    client?.on('message', handler)
    client?.emit('message', { id: 7, name: 'x', args: [1] })
    expect(backend.listen).toHaveBeenCalledWith('message', handler)
    expect(backend.post).toHaveBeenCalledWith({ id: 7, name: 'x', args: [1] })
  })

  it('names the missing backend script instead of failing on undefined', () => {
    const { bridge } = runBridge(source)
    expect(() => bridge['ipcConnect'](() => {})).toThrow(/ipcConnect is unavailable.*backend script did not load/)
  })
})

describe('files and the backend', () => {
  it('resolves the paths the backend can read for a file dialog, and undefined for a cancel', async () => {
    const { bridge, backend } = load()
    expect(await bridge['openFileDialog']({ properties: ['openFile'] })).toEqual(['/orivon/app/actual-imports/x/a.zip'])
    expect(backend.openFileDialog).toHaveBeenCalledWith({ properties: ['openFile'] })
    backend.openFileDialog.mockResolvedValueOnce(undefined as never)
    expect(await bridge['openFileDialog']({})).toBeUndefined()
  })

  it('hands a saved file to the backend script with its name and title', async () => {
    const { bridge, backend } = load()
    await bridge['saveFile']('text', 'a.csv', 'Export')
    expect(backend.saveFile).toHaveBeenCalledWith('text', 'a.csv', 'Export')
  })

  it('restarts the backend on request, and reloads the page to relaunch', () => {
    const reload = vi.fn()
    const { bridge, backend, sandbox } = load()
    sandbox.window['location'] = { reload }
    bridge['restartElectronServer']()
    bridge['relaunch']()
    expect(backend.restart).toHaveBeenCalled()
    expect(reload).toHaveBeenCalled()
  })

  it('opens a link in a tab of its own with no opener', () => {
    const open = vi.fn()
    const { bridge, sandbox } = load()
    sandbox.window['open'] = open
    bridge['openURLInBrowser']('https://actualbudget.org/')
    expect(open).toHaveBeenCalledWith('https://actualbudget.org/', '_blank', 'noopener,noreferrer')
  })
})

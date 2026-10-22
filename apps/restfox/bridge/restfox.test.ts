// What is Restfox's own about this bridge: the roster of 35 members its preload
// exposes, the names bound to what its renderer expects behind them, and the
// four that carry a decision. The kit's behaviours are covered in src/bridge/.
// What runs below is the composed script, byte for byte what the browser is served.
import { describe, expect, it, vi } from 'vitest'
import { bridgeSourceFor, runBridge } from '../../../src/testing/bridge-harness.ts'
import type { LoadOptions } from '../../../src/testing/bridge-harness.ts'

const source = await bridgeSourceFor('restfox')

// Every name in the `ipcFunctions` list of packages/electron/src/preload.js at the pin, plus workspaceChanged.
const MEMBERS = [
  'cancelRequest', 'createCollection', 'createCollections', 'createPlugin', 'createPlugins', 'createResponse',
  'deleteCollectionsByIds', 'deleteCollectionsByWorkspaceId', 'deletePlugin', 'deletePluginsByCollectionIds',
  'deletePluginsByWorkspace', 'deleteResponse', 'deleteResponsesByCollectionId', 'deleteResponsesByCollectionIds',
  'deleteResponsesByIds', 'ensureEmptyFolderOrEmptyWorkspace', 'getCollectionById', 'getCollectionForWorkspace',
  'getInstallInfo', 'getResponsesByCollectionId', 'getWorkspaceAtLocation', 'getWorkspacePlugins', 'openFolder',
  'openFolderSelectionDialog', 'readFile', 'sendRequest', 'setCACertificates', 'setDisableSSLVerification',
  'setProxy', 'updateCollection', 'updatePlugin', 'updateResponse', 'updateWorkspace', 'updateElectronApp',
  'workspaceChanged'
] as const

const FILE_WORKSPACE_MEMBERS = MEMBERS.filter((name) => !['cancelRequest', 'getInstallInfo', 'sendRequest', 'setCACertificates', 'setDisableSSLVerification', 'setProxy', 'updateElectronApp', 'workspaceChanged'].includes(name))

interface Sent { url: string, init: Record<string, any> }

/** A fetch that records what it was given and answers with a response of its own making. */
function fakeFetch (answer: () => Promise<unknown> | unknown) {
  const sent: Sent[] = []
  const fetch = vi.fn(async (url: string, init: Record<string, any>) => {
    sent.push({ url, init })
    return await answer()
  })
  return { sent, fetch }
}

function response (body: string, init: { status?: number, statusText?: string, headers?: Array<[string, string]>, type?: string } = {}) {
  const bytes = new TextEncoder().encode(body)
  return {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { entries: () => (init.headers ?? [['content-type', 'text/plain']])[Symbol.iterator]() },
    blob: async () => ({ type: init.type ?? 'text/plain', arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
  }
}

function freshBridge (options: LoadOptions & { storage?: Record<string, string>, fetch?: unknown } = {}) {
  const storage = options.storage ?? {}
  const localStorage = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => { storage[key] = value }
  }
  const { fetch, ...rest } = options
  const loaded = runBridge(source, {
    ...rest,
    globals: { AbortController, File, FormData, Blob, ...(fetch === undefined ? {} : { fetch }), window: { localStorage } }
  })
  return { ...loaded, storage }
}

const request = (extra: Record<string, unknown> = {}) => ({ requestId: 'r1', url: 'https://echo.example/anything', method: 'GET', headers: {}, body: undefined, bodyHint: null, disableSSLVerification: false, ...extra })

describe('the roster', () => {
  it('installs exactly the 35 members Restfox exposes, on window.electronIPC', () => {
    const { bridge, sandbox } = freshBridge()
    expect(Object.keys(bridge).sort()).toEqual([...MEMBERS].sort())
    expect(sandbox.window['electronIPC']).toBe(bridge)
  })

  it('answers the install query as an install this build does not recognise', async () => {
    const { bridge } = freshBridge()
    expect(await bridge.getInstallInfo()).toEqual({ appName: 'Restfox', installKind: 'other' })
  })

  it('records the workspaceChanged callback and never calls it', () => {
    const { bridge, recordedListeners } = freshBridge()
    const callback = vi.fn()
    bridge.workspaceChanged(callback)
    expect(recordedListeners['workspaceChanged']).toBe(callback)
    expect(callback).not.toHaveBeenCalled()
  })

  it('treats the updater call and the certificate switch as nothing to do', () => {
    const { bridge } = freshBridge()
    expect(bridge.updateElectronApp()).toBeUndefined()
    expect(bridge.setDisableSSLVerification(true)).toBeUndefined()
  })
})

describe('file workspaces are refused by name', () => {
  it.each(FILE_WORKSPACE_MEMBERS)('%s throws a not-built refusal', (name) => {
    const { bridge } = freshBridge()
    let thrown: any
    try { bridge[name]({}, {}) } catch (error) { thrown = error }
    expect(thrown?.name).toBe('OrivonBridgeError')
    expect(thrown?.reason).toBe('not-built')
    expect(thrown?.message).toContain(`electronIPC.${name}`)
  })
})

describe('sendRequest', () => {
  it('hands fetch the url, method and headers as written, Cookie and Origin included', async () => {
    const { sent, fetch } = fakeFetch(() => response('{}'))
    const { bridge } = freshBridge({ fetch })
    const headers = { Cookie: 'sid=abc', Origin: 'https://example.test', Authorization: 'Bearer t', 'X-Custom': '1' }
    const result = await bridge.sendRequest(request({ method: 'POST', headers, body: 'hello' }))
    expect(result.event).toBe('response')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe('https://echo.example/anything')
    expect(sent[0]?.init['method']).toBe('POST')
    expect(sent[0]?.init['headers']).toBe(headers)
    expect(sent[0]?.init['body']).toBe('hello')
  })

  it('sends no body for GET, as Restfox\'s main process does', async () => {
    const { sent, fetch } = fakeFetch(() => response(''))
    const { bridge } = freshBridge({ fetch })
    await bridge.sendRequest(request({ body: 'ignored' }))
    expect(sent[0]?.init['body']).toBeUndefined()
  })

  it('answers with the status, the headers, the mime type and the bytes', async () => {
    const { fetch } = fakeFetch(() => response('abc', { status: 201, statusText: 'Created', headers: [['content-type', 'text/plain'], ['set-cookie', 'a=b']], type: 'text/plain' }))
    const { bridge } = freshBridge({ fetch })
    const { event, eventData } = await bridge.sendRequest(request({ headers: { 'X-A': 'b' } }))
    expect(event).toBe('response')
    expect(eventData.status).toBe(201)
    expect(eventData.statusText).toBe('Created')
    expect(eventData.headers).toEqual([['content-type', 'text/plain'], ['set-cookie', 'a=b']])
    expect(eventData.mimeType).toBe('text/plain')
    expect(new TextDecoder().decode(new Uint8Array(eventData.buffer))).toBe('abc')
    expect(eventData.requestHeadersSent).toEqual([['X-A', 'b']])
    expect(typeof eventData.timeTaken).toBe('number')
  })

  it('rebuilds a file body and a form body from the plain data the renderer marshals', async () => {
    const { sent, fetch } = fakeFetch(() => response(''))
    const { bridge } = freshBridge({ fetch })
    const file = { name: 'a.txt', type: 'text/plain', buffer: [104, 105] }
    await bridge.sendRequest(request({ method: 'PUT', body: file, bodyHint: 'File' }))
    const sentFile = sent[0]?.init['body']
    expect(sentFile.name).toBe('a.txt')
    expect(sentFile.type).toBe('text/plain')
    expect(await sentFile.text()).toBe('hi')

    await bridge.sendRequest(request({ method: 'POST', body: [['field', 'value'], ['upload', file]], bodyHint: 'FormData' }))
    const form = sent[1]?.init['body']
    expect(form.get('field')).toBe('value')
    expect(form.get('upload').name).toBe('a.txt')
  })

  it('reports a failed request as a responseError with its cause', async () => {
    const failure = Object.assign(new TypeError('Failed to fetch'), { cause: new Error('connection to a.example:443 failed (ECONNREFUSED: refused)') })
    const { fetch } = fakeFetch(() => { throw failure })
    const { bridge } = freshBridge({ fetch })
    const result = await bridge.sendRequest(request())
    expect(result.event).toBe('responseError')
    expect(result.eventData).toBe('TypeError: Failed to fetch\nCaused by: Error: connection to a.example:443 failed (ECONNREFUSED: refused)')
  })

  it('rejects with a message Restfox prints when a certificate is refused, and says the setting does not apply', async () => {
    const failure = Object.assign(new TypeError('Failed to fetch'), { cause: new Error('connection to a.example:443 failed (ERR_CERT_AUTHORITY_INVALID: certificate rejected)') })
    const { fetch } = fakeFetch(() => { throw failure })
    const { bridge } = freshBridge({ fetch })
    await bridge.setDisableSSLVerification(true)
    const error = await bridge.sendRequest(request()).then(() => undefined, (rejected: any) => rejected)
    expect(error?.cause).toBe('display-error')
    expect(error?.message).toContain('Disable SSL Verification and CA Certificates in Settings do not apply')
    expect(error?.message).toContain('ERR_CERT_AUTHORITY_INVALID')
  })

  it('does not take a host name that merely contains ssl for a certificate failure', async () => {
    const failure = Object.assign(new TypeError('Failed to fetch'), { cause: new Error('connection to ssl.example:443 failed (ECONNREFUSED: refused)') })
    const { fetch } = fakeFetch(() => { throw failure })
    const { bridge } = freshBridge({ fetch })
    expect((await bridge.sendRequest(request({ url: 'https://ssl.example/' }))).event).toBe('responseError')
  })

  it('tells the user which plain http requests are reachable when one fails', async () => {
    const { fetch } = fakeFetch(() => { throw new TypeError('Failed to fetch') })
    const { bridge } = freshBridge({ fetch })
    const error = await bridge.sendRequest(request({ url: 'http://example.test/x' })).then(() => undefined, (rejected: any) => rejected)
    expect(error?.cause).toBe('display-error')
    expect(error?.message).toContain('Plain http:// requests are sent only to the localhost ports')
    expect((await bridge.sendRequest(request({ url: 'https://example.test/x' }))).event).toBe('responseError')
  })

  it('sends nothing at all while Settings > Proxy is Custom, and sends again once it is not', async () => {
    const { sent, fetch } = fakeFetch(() => response('ok'))
    const { bridge } = freshBridge({ fetch })
    await bridge.setProxy({ mode: 'custom', url: 'http://proxy.example:8080' })
    const refused = await bridge.sendRequest(request()).then(() => undefined, (rejected: any) => rejected)
    expect(refused?.cause).toBe('display-error')
    expect(refused?.message).toContain('Settings > Proxy is set to Custom')
    expect(sent).toHaveLength(0)
    await bridge.setProxy({ mode: 'off' })
    expect((await bridge.sendRequest(request())).event).toBe('response')
    await bridge.setProxy(null)
    expect((await bridge.sendRequest(request())).event).toBe('response')
  })

  it('aborts the fetch\'s signal on cancelRequest, and honours a cancel that arrives first', async () => {
    let seen: AbortSignal | undefined
    let release: () => void = () => {}
    const fetch = vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
      seen = init.signal
      if (!init.signal.aborted) await new Promise<void>((resolve) => { release = resolve; init.signal.addEventListener('abort', () => { resolve() }) })
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
    })
    const { bridge } = freshBridge({ fetch })
    const pending = bridge.sendRequest(request({ requestId: 'late' }))
    await Promise.resolve()
    await bridge.cancelRequest('late')
    expect(seen?.aborted).toBe(true)
    expect((await pending).event).toBe('responseError')
    release()

    await bridge.cancelRequest('early')
    const second = await bridge.sendRequest(request({ requestId: 'early' }))
    expect(second.event).toBe('responseError')
    expect(seen?.aborted).toBe(true)
  })
})

describe('settings main applied to its own client', () => {
  it('lets a profile with no CA file through and refuses to keep one', async () => {
    const { bridge } = freshBridge()
    expect(await bridge.setCACertificates(null)).toEqual({ error: null })
    expect(await bridge.setCACertificates('')).toEqual({ error: null })
    const refused = await bridge.setCACertificates('-----BEGIN CERTIFICATE-----')
    expect(refused.error).toContain('cannot add certificate authorities')
  })
})

describe('upstream\'s page-view ping', () => {
  it('is off in a new profile, and a choice already made stays', () => {
    expect(freshBridge().storage['Restfox-DisablePageViewAnalyticsTracking']).toBe('true')
    expect(freshBridge({ storage: { 'Restfox-DisablePageViewAnalyticsTracking': 'false' } }).storage['Restfox-DisablePageViewAnalyticsTracking']).toBe('false')
  })
})

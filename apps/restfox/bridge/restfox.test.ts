// What is Restfox's own about this bridge: the roster of 44 members its preload
// exposes, the names bound to what its renderer expects behind them, and the
// six that carry a decision. The kit's behaviours are covered in src/bridge/.
// What runs below is the composed script, byte for byte what the browser is served.
import { describe, expect, it, vi } from 'vitest'
import { bridgeSourceFor, runBridge } from '../../../src/testing/bridge-harness.ts'
import type { LoadOptions } from '../../../src/testing/bridge-harness.ts'

const source = await bridgeSourceFor('restfox')

// Every name in the `ipcFunctions` list of packages/electron/src/preload.js at the pin, plus the three callbacks it registers.
const MEMBERS = [
  'cancelRequest', 'createCollection', 'createCollections', 'createPlugin', 'createPlugins', 'createResponse',
  'deleteCollectionsByIds', 'deleteCollectionsByWorkspaceId', 'deletePlugin', 'deletePluginsByCollectionIds',
  'deletePluginsByWorkspace', 'deleteResponse', 'deleteResponsesByCollectionId', 'deleteResponsesByCollectionIds',
  'deleteResponsesByIds', 'ensureEmptyFolderOrEmptyWorkspace', 'getCollectionById', 'getCollectionForWorkspace',
  'getInstallInfo', 'getResponsesByCollectionId', 'getWorkspaceAtLocation', 'getWorkspacePlugins', 'openFolder',
  'openFolderSelectionDialog', 'readFile', 'sendRequest', 'setCACertificates', 'setDisableSSLVerification',
  'setProxy', 'updateCollection', 'updatePlugin', 'updateResponse', 'updateWorkspace', 'updateElectronApp',
  'workspaceChanged', 'onRequestEvent', 'onGrpcEvent',
  'grpcLoadSchema', 'grpcCancelSchemaLoad', 'grpcConvertInsomniaMessage', 'grpcStartCall', 'grpcSendMessage', 'grpcEndCall', 'grpcCancelCall'
] as const

const GRPC_MEMBERS = MEMBERS.filter((name) => name.startsWith('grpc'))

const FILE_WORKSPACE_MEMBERS = MEMBERS.filter((name) => !['cancelRequest', 'getInstallInfo', 'sendRequest', 'setCACertificates', 'setDisableSSLVerification', 'setProxy', 'updateElectronApp', 'workspaceChanged', 'onRequestEvent', 'onGrpcEvent', ...GRPC_MEMBERS].includes(name))

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

/** A response whose body arrives in the chunks given, or fails after them when `failure` is set. */
function response (body: string | string[], init: { status?: number, statusText?: string, headers?: Array<[string, string]>, failure?: Error } = {}) {
  const chunks = (Array.isArray(body) ? body : [body]).map((text) => new TextEncoder().encode(text))
  let index = 0
  const reader = {
    read: async () => {
      if (index < chunks.length) return { done: false, value: chunks[index++] }
      if (init.failure !== undefined) throw init.failure
      return { done: true, value: undefined }
    }
  }
  return {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { entries: () => (init.headers ?? [['content-type', 'text/plain']])[Symbol.iterator]() },
    body: { getReader: () => reader }
  }
}

function freshBridge (options: Omit<LoadOptions, 'fetch'> & { fetch?: unknown } = {}) {
  const alerts: string[] = []
  const { fetch, ...rest } = options
  const loaded = runBridge(source, {
    ...rest,
    globals: { AbortController, File, FormData, Blob, ...(fetch === undefined ? {} : { fetch }), window: { alert: (message: string) => { alerts.push(message) } } }
  })
  return { ...loaded, alerts }
}

/** What the page's callback gets for every request, in order: [requestId, message]. */
function collecting (bridge: Record<string, any>) {
  const events: Array<[string, { event: string, eventData: any }]> = []
  bridge['onRequestEvent']((requestId: string, message: { event: string, eventData: any }) => { events.push([requestId, message]) })
  return events
}

const names = (events: Array<[string, { event: string }]>) => events.map(([, message]) => message.event)

const request = (extra: Record<string, unknown> = {}) => ({ requestId: 'r1', url: 'https://echo.example/anything', method: 'GET', headers: {}, body: undefined, bodyHint: null, disableSSLVerification: false, ...extra })

describe('the roster', () => {
  it('installs exactly the 44 members Restfox exposes, on window.electronIPC', () => {
    const { bridge, sandbox } = freshBridge()
    expect(Object.keys(bridge).sort()).toEqual([...MEMBERS].sort())
    expect(sandbox.window['electronIPC']).toBe(bridge)
  })

  it('answers the install query as an install this build does not recognise', async () => {
    const { bridge } = freshBridge()
    expect(await bridge.getInstallInfo()).toEqual({ appName: 'Restfox', installKind: 'other' })
  })

  it.each(['workspaceChanged', 'onGrpcEvent'])('records the %s callback and never calls it', (name) => {
    const { bridge, recordedListeners } = freshBridge()
    const callback = vi.fn()
    bridge[name](callback)
    expect(recordedListeners[name]).toBe(callback)
    expect(callback).not.toHaveBeenCalled()
  })

  it('treats the updater call and the certificate switch as nothing to do', () => {
    const { bridge } = freshBridge()
    expect(bridge.updateElectronApp()).toBeUndefined()
    expect(bridge.setDisableSSLVerification(true)).toBeUndefined()
  })
})

describe('file workspaces are refused by name', () => {
  it('says why before it refuses the folder picker, so the Choose button is not silent', () => {
    const { bridge, alerts } = freshBridge()
    expect(() => bridge.openFolderSelectionDialog()).toThrow(/openFolderSelectionDialog is unavailable/)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('Choose the type "In Application"')
  })

  it.each(FILE_WORKSPACE_MEMBERS)('%s throws a not-built refusal', (name) => {
    const { bridge } = freshBridge()
    let thrown: any
    try { bridge[name]({}, {}) } catch (error) { thrown = error }
    expect(thrown?.name).toBe('OrivonBridgeError')
    expect(thrown?.reason).toBe('not-built')
    expect(thrown?.message).toContain(`electronIPC.${name}`)
  })
})

describe('gRPC is refused by name', () => {
  it.each(GRPC_MEMBERS)('%s rejects with a not-built refusal that says gRPC is unavailable', async (name) => {
    const { bridge } = freshBridge()
    const rejected = await Promise.resolve().then(() => bridge[name]({}, {})).then(() => undefined, (error: any) => error)
    expect(rejected?.name).toBe('OrivonBridgeError')
    expect(rejected?.reason).toBe('not-built')
    expect(rejected?.message).toContain(`electronIPC.${name}`)
    expect(rejected?.message).toContain('gRPC calls are not available in this build')
  })

  it('returns a promise from a call that Restfox chains a catch to, instead of throwing', () => {
    const { bridge } = freshBridge()
    const returned = bridge.grpcStartCall({})
    expect(typeof returned.catch).toBe('function')
    returned.catch(() => undefined)
  })
})

describe('sendRequest', () => {
  it('hands fetch the url, method and headers as written, Cookie and Origin included', async () => {
    const { sent, fetch } = fakeFetch(() => response('{}'))
    const { bridge } = freshBridge({ fetch })
    const headers = { Cookie: 'sid=abc', Origin: 'https://example.test', Authorization: 'Bearer t', 'X-Custom': '1' }
    expect(await bridge.sendRequest(request({ method: 'POST', headers, body: 'hello' }))).toBeUndefined()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe('https://echo.example/anything')
    expect(sent[0]?.init['method']).toBe('POST')
    expect(sent[0]?.init['headers']).toBe(headers)
    expect(sent[0]?.init['body']).toBe('hello')
  })

  it.each(['GET', 'get', 'HEAD', 'Head', undefined])('sends no body for %s, which fetch refuses one for', async (method) => {
    const { sent, fetch } = fakeFetch(() => response(''))
    const { bridge } = freshBridge({ fetch })
    await bridge.sendRequest(request({ method, body: 'ignored' }))
    expect(sent[0]?.init['body']).toBeUndefined()
  })

  it('pushes the head, then each chunk, then the end, to every callback onRequestEvent holds', async () => {
    const { fetch } = fakeFetch(() => response(['ab', '', 'c'], { status: 201, statusText: 'Created', headers: [['content-type', 'text/plain'], ['set-cookie', 'a=b']] }))
    const { bridge } = freshBridge({ fetch })
    const events = collecting(bridge)
    const second = collecting(bridge)
    await bridge.sendRequest(request({ requestId: 'r7', headers: { 'X-A': 'b' } }))
    expect(names(events)).toEqual(['head', 'data', 'data', 'end'])
    expect(second).toHaveLength(4)
    expect(events.every(([requestId]) => requestId === 'r7')).toBe(true)
    const [head, first, last, end] = events.map(([, message]) => message.eventData)
    expect(head.status).toBe(201)
    expect(head.statusText).toBe('Created')
    expect(head.headers).toEqual([['content-type', 'text/plain'], ['set-cookie', 'a=b']])
    expect(head.requestHeadersSent).toEqual([['X-A', 'b']])
    expect(typeof head.headTimeTaken).toBe('number')
    expect(new TextDecoder().decode(first)).toBe('ab')
    expect(new TextDecoder().decode(last)).toBe('c')
    expect(typeof end.timeTaken).toBe('number')
    expect(typeof end.bodyTimeTaken).toBe('number')
  })

  it('pushes a chunk before the next one is read, so a stream shows live', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let step = 0
    const streaming = {
      status: 200,
      statusText: 'OK',
      headers: { entries: () => [['content-type', 'text/event-stream']][Symbol.iterator]() },
      body: { getReader: () => ({ read: async () => {
        step += 1
        if (step === 1) return { done: false, value: new TextEncoder().encode('data: one\n\n') }
        await gate
        return { done: true, value: undefined }
      } }) }
    }
    const { fetch } = fakeFetch(() => streaming)
    const { bridge } = freshBridge({ fetch })
    const events = collecting(bridge)
    const sending = bridge.sendRequest(request())
    for (let tick = 0; tick < 20 && events.length < 2; tick += 1) await Promise.resolve()
    expect(names(events)).toEqual(['head', 'data'])
    release()
    await sending
    expect(names(events)).toEqual(['head', 'data', 'end'])
  })

  it('answers a response with no body as a head and an end', async () => {
    const { fetch } = fakeFetch(() => ({ ...response(''), body: null }))
    const { bridge } = freshBridge({ fetch })
    const events = collecting(bridge)
    await bridge.sendRequest(request())
    expect(names(events)).toEqual(['head', 'end'])
  })

  it('pushes a bodyError with what arrived before it when the body fails after the head', async () => {
    const failure = Object.assign(new TypeError('terminated'), { cause: new Error('other side closed') })
    const { fetch } = fakeFetch(() => response('partial', { failure }))
    const { bridge } = freshBridge({ fetch })
    const events = collecting(bridge)
    await bridge.sendRequest(request())
    expect(names(events)).toEqual(['head', 'data', 'bodyError'])
    const { message, timeTaken, bodyTimeTaken } = events[2]?.[1].eventData
    expect(message).toBe('terminated: other side closed')
    expect(typeof timeTaken).toBe('number')
    expect(typeof bodyTimeTaken).toBe('number')
  })

  it('pushes nothing more once a cancel has cut the body short', async () => {
    let cancelled: () => void = () => {}
    const stopped = new Promise<void>((resolve) => { cancelled = resolve })
    let seen: AbortSignal | undefined
    const fetch = vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
      seen = init.signal
      return {
        ...response(''),
        body: { getReader: () => ({ read: async () => {
          await stopped
          throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
        } }) }
      }
    })
    const { bridge } = freshBridge({ fetch })
    const events = collecting(bridge)
    const sending = bridge.sendRequest(request({ requestId: 'cut' }))
    for (let tick = 0; tick < 20 && events.length < 1; tick += 1) await Promise.resolve()
    await bridge.cancelRequest('cut')
    expect(seen?.aborted).toBe(true)
    cancelled()
    await sending
    expect(names(events)).toEqual(['head'])
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

  it('pushes a failed request as a responseError with its cause', async () => {
    const failure = Object.assign(new TypeError('Failed to fetch'), { cause: new Error('connection to a.example:443 failed (ECONNREFUSED: refused)') })
    const { fetch } = fakeFetch(() => { throw failure })
    const { bridge } = freshBridge({ fetch })
    const events = collecting(bridge)
    await bridge.sendRequest(request())
    expect(events).toHaveLength(1)
    expect(events[0]?.[1].event).toBe('responseError')
    expect(events[0]?.[1].eventData).toBe('TypeError: Failed to fetch\nCaused by: Error: connection to a.example:443 failed (ECONNREFUSED: refused)')
  })

  it('rejects with a message Restfox prints when a certificate is refused, and says the setting does not apply', async () => {
    const failure = Object.assign(new TypeError('Failed to fetch'), { cause: new Error('connection to a.example:443 failed (ERR_CERT_AUTHORITY_INVALID: certificate rejected)') })
    const { fetch } = fakeFetch(() => { throw failure })
    const { bridge } = freshBridge({ fetch })
    const events = collecting(bridge)
    await bridge.setDisableSSLVerification(true)
    const error = await bridge.sendRequest(request()).then(() => undefined, (rejected: any) => rejected)
    expect(error?.cause).toBe('display-error')
    expect(error?.message).toContain('Disable SSL Verification and CA Certificates in Settings do not apply')
    expect(error?.message).toContain('ERR_CERT_AUTHORITY_INVALID')
    expect(events).toHaveLength(0)
  })

  it('does not take a host name that merely contains ssl for a certificate failure', async () => {
    const failure = Object.assign(new TypeError('Failed to fetch'), { cause: new Error('connection to ssl.example:443 failed (ECONNREFUSED: refused)') })
    const { fetch } = fakeFetch(() => { throw failure })
    const { bridge } = freshBridge({ fetch })
    const events = collecting(bridge)
    await bridge.sendRequest(request({ url: 'https://ssl.example/' }))
    expect(names(events)).toEqual(['responseError'])
  })

  it('tells the user which plain http requests are reachable when one fails', async () => {
    const { fetch } = fakeFetch(() => { throw new TypeError('Failed to fetch') })
    const { bridge } = freshBridge({ fetch })
    const events = collecting(bridge)
    const error = await bridge.sendRequest(request({ url: 'http://example.test/x' })).then(() => undefined, (rejected: any) => rejected)
    expect(error?.cause).toBe('display-error')
    expect(error?.message).toContain('Plain http:// requests are sent only to the localhost ports')
    await bridge.sendRequest(request({ url: 'https://example.test/x' }))
    expect(names(events)).toEqual(['responseError'])
  })

  it('says the same for https to this computer or a private address, and not for a public one', async () => {
    const { fetch } = fakeFetch(() => { throw new TypeError('Failed to fetch') })
    const { bridge } = freshBridge({ fetch })
    const events = collecting(bridge)
    for (const url of ['https://localhost:3001/', 'https://127.0.0.1/', 'https://192.168.1.5/', 'http://localhost:3002/', 'https://[::1]:8443/', 'https://nas.local/']) {
      const error = await bridge.sendRequest(request({ url })).then(() => undefined, (rejected: any) => rejected)
      expect(error?.cause, url).toBe('display-error')
      expect(error?.message, url).toContain('this computer and private networks only over plain http://')
    }
    expect(events).toHaveLength(0)
    for (const url of ['https://8.8.8.8/', 'https://example.test/', 'https://172.32.0.1/']) {
      await bridge.sendRequest(request({ url }))
    }
    expect(names(events)).toEqual(['responseError', 'responseError', 'responseError'])
  })

  it('keeps Restfox\'s own failure for a plain http request that was routed and failed', async () => {
    const failure = Object.assign(new TypeError('Failed to fetch'), { cause: new Error('connection to localhost:3001 failed (ECONNREFUSED: refused)') })
    const { fetch } = fakeFetch(() => { throw failure })
    const { bridge } = freshBridge({ fetch })
    const events = collecting(bridge)
    await bridge.sendRequest(request({ url: 'http://localhost:3001/' }))
    expect(names(events)).toEqual(['responseError'])
  })

  it('names the localhost ports the served manifest grants', async () => {
    const manifest = { capabilities: { net: { tcp: { connect: ['localhost:3000', 'localhost:8080', '10.0.0.1:80'] } } } }
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('.well-known/orivon.json')) return { json: async () => manifest }
      throw new TypeError('Failed to fetch')
    })
    const { bridge } = freshBridge({ fetch })
    const error = await bridge.sendRequest(request({ url: 'http://example.test/x' })).then(() => undefined, (rejected: any) => rejected)
    expect(error?.message).toContain('permission for (3000, 8080).')
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1/.well-known/orivon.json')
  })

  it('sends nothing at all while Settings > Proxy is Custom, and sends again once it is not', async () => {
    const { sent, fetch } = fakeFetch(() => response('ok'))
    const { bridge } = freshBridge({ fetch })
    const events = collecting(bridge)
    await bridge.setProxy({ mode: 'custom', url: 'http://proxy.example:8080' })
    const refused = await bridge.sendRequest(request()).then(() => undefined, (rejected: any) => rejected)
    expect(refused?.cause).toBe('display-error')
    expect(refused?.message).toContain('Settings > Proxy is set to Custom')
    expect(sent).toHaveLength(0)
    await bridge.setProxy({ mode: 'off' })
    await bridge.sendRequest(request())
    expect(names(events)).toEqual(['head', 'data', 'end'])
    await bridge.setProxy(null)
    await bridge.sendRequest(request())
    expect(names(events)).toHaveLength(6)
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
    const events = collecting(bridge)
    const pending = bridge.sendRequest(request({ requestId: 'late' }))
    await Promise.resolve()
    await bridge.cancelRequest('late')
    expect(seen?.aborted).toBe(true)
    await pending
    expect(names(events)).toEqual(['responseError'])
    release()

    seen = undefined
    await bridge.cancelRequest('early')
    await bridge.sendRequest(request({ requestId: 'early' }))
    expect(names(events)).toEqual(['responseError', 'responseError'])
    expect((seen as AbortSignal | undefined)?.aborted).toBe(true)
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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCar } from '../page/src/ipfs/car.js'
import { memoryBackend } from '../page/src/keep/backends.js'
import { createKeep } from '../page/src/keep/store.js'
import { readZip } from '../page/src/lib/zip.js'
import { createServing } from '../page/src/serve/manager.js'
import { createTrackerHub } from '../page/src/serve/tracker.js'
import { useRuntime } from '../page/src/runtime.js'
import * as engine from '../page/src/engine.js'

vi.mock('../page/src/crypto/client.js', async () => ({
  encryptBlob: async (blob: Blob, password: string) => new Blob([`FAKE:${password}:`, blob]),
  decryptBlob: async (blob: Blob, password: string) => blob.slice(`FAKE:${password}:`.length)
}))

const entry = (path: string, content: string) => ({ path, file: new Blob([content]) })
const KUBO = { id: 'k', kind: 'kubo' as const, values: { endpoint: 'http://127.0.0.1:5001' } }

class NeverOpens {
  onopen: unknown
  onclose: unknown
  close () {}
  send () {}
}

function runtime (supported = true) {
  const keep = createKeep(memoryBackend())
  const hub = createTrackerHub({ peerId: 'p'.repeat(20), WebSocketImpl: NeverOpens as unknown as typeof WebSocket })
  const serving = createServing({ keep, hub, supported })
  useRuntime({ keep, serving, hub, supported, storage: { durable: false, kind: 'memory' } })
  return { keep, serving, hub }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('the facade', () => {
  it('offers what the page imports from the engine, and nothing of Orivon\'s own hosting', () => {
    expect(Object.keys(engine).sort()).toEqual([
      'LIMITS', 'TARGET_KINDS', 'checkSelection', 'closeShare', 'deleteKept', 'embedAvailable', 'entriesFromDrop', 'entriesFromInput',
      'environment', 'exportCar', 'generatePassword', 'keepCopy', 'keptShares', 'mimeTypeOf', 'onServingChange', 'openShare', 'parseShareLink',
      'passwordStrength', 'pinElsewhere', 'publishShare', 'readPublicFile', 'servingState', 'setOnline', 'shareLink', 'startServing',
      'startSiteServer', 'storageInfo', 'testTarget', 'unlockShare', 'zipEntries', 'zipPublic'
    ].sort())
    expect('FREE_TARGET' in engine).toBe(false)
    expect(Object.keys(engine.TARGET_KINDS)).toEqual(['kubo', 'filebase', 'pinata', 'rpc'])
  })

  it('states the limits a page shows', () => {
    expect(engine.LIMITS).toEqual({ maxShareBytes: 1024 ** 3, maxFiles: 10_000, maxFolderEntries: 1000, minPasswordLength: 10, copyBytes: 200 * 1024 ** 2, copyDays: 30 })
  })

  it('works the password helpers and the link helpers through the facade', () => {
    expect(engine.generatePassword()).toMatch(/^[0-9a-z]{5}(-[0-9a-z]{5}){4}$/)
    expect(engine.passwordStrength('short').acceptable).toBe(false)
    const cid = 'bafybeiek6rgo53nnksskarhmyk2ussqywifoxhs45j7y3l4mlis5nlqziu'
    expect(engine.parseShareLink(engine.shareLink(cid, 'pw'))).toEqual({ cid, password: 'pw' })
    expect(engine.mimeTypeOf('a.html')).toBe('text/html; charset=utf-8')
    expect(engine.checkSelection([entry('a.txt', 'x')], 'files')).toMatchObject({ ok: true })
  })

  it('makes a ZIP of entries', async () => {
    const zip = await engine.zipEntries([{ path: 'a.txt', file: new Blob(['hello']) }, { path: 'd/b.txt', file: new Blob(['bee']) }])
    expect((await readZip(zip)).map((e) => e.path)).toEqual(['a.txt', 'd/b.txt'])
  })

  it('checks a target the way its service is checked, and says what the service refused', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"Version":"0.43.1"}'))
    await expect(engine.testTarget(KUBO)).resolves.toBeUndefined()
    vi.stubGlobal('fetch', async () => new Response('', { status: 403 }))
    await expect(engine.testTarget(KUBO)).rejects.toThrow('refused the key')
  })
})

describe('what this page can do', () => {
  it('knows it is in a plain browser', () => {
    vi.stubGlobal('window', {})
    expect(engine.environment()).toMatchObject({ orivon: false, pageNode: false, embed: false })
    expect(typeof engine.environment().webrtc).toBe('boolean')
  })

  it('knows Orivon with sockets and with the means to show a site', () => {
    vi.stubGlobal('window', { orivon: { net: { connect () {}, listen () {} }, web: { setEmbedScript () {} } } })
    expect(engine.environment()).toMatchObject({ orivon: true, pageNode: true, embed: true })
    vi.stubGlobal('window', { orivon: { net: { connect () {} } } })
    expect(engine.environment()).toMatchObject({ orivon: true, pageNode: false, embed: false })
  })

  it('asks whether the person allowed a site to be shown inside the page, by trying', async () => {
    const setEmbedScript = vi.fn(async () => {})
    vi.stubGlobal('window', { orivon: { net: { connect () {}, listen () {} }, web: { setEmbedScript } } })
    expect(await engine.embedAvailable()).toBe(true)
    expect(setEmbedScript).toHaveBeenCalledWith('')
    vi.stubGlobal('window', { orivon: { net: { listen () {} }, web: { setEmbedScript: async () => { throw new Error('denied') } } } })
    expect(await engine.embedAvailable()).toBe(false)
    vi.stubGlobal('window', {})
    expect(await engine.embedAvailable()).toBe(false)
  })

  it('shows a site only where it may, and gives the place to show it', async () => {
    vi.stubGlobal('window', {})
    await expect(engine.startSiteServer('bafy', [], new Uint8Array(32))).rejects.toThrow('needs Orivon')
    const closed: number[] = []
    const listen = vi.fn(async ({ port }: { port: number }) => ({ localPort: port, connections: new ReadableStream(), close: async () => { closed.push(port) } }))
    vi.stubGlobal('window', { orivon: { net: { listen }, web: { setEmbedScript: async () => {} } } })
    const site = await engine.startSiteServer('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku', [{ path: 'index.html', size: 1, file: new Blob(['x']) }], new Uint8Array(32).fill(7))
    expect(site.url).toMatch(/^http:\/\/[a-z2-7]{32}\.localhost:5210\/$/)
    expect(site.origin + '/').toBe(site.url)
    expect(listen).toHaveBeenCalledWith({ port: 5210, scope: 'local' })
    const same = await engine.startSiteServer('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku', [], 'a secret kept in the page')
    expect(same.url).not.toBe(site.url)
    site.stop()
    same.stop()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(closed).toEqual([5210])
  })
})

describe('what is kept on this computer', () => {
  it('says nothing is served before the page started serving, and then what is', async () => {
    runtime()
    const { cid } = await engine.publishShare({ kind: 'files', entries: [entry('a.txt', 'hello')] })
    expect(engine.servingState().shares.map((s) => s.cid)).toEqual([cid])
    await engine.startServing()
    await engine.startServing()
    expect(engine.servingState()).toMatchObject({ supported: true, shares: [{ cid, online: true, peers: 0, uploaded: 0, node: 'off' }] })
  })

  it('tells whoever listens when a share is stopped, started or deleted', async () => {
    const { keep } = runtime()
    const heard: string[] = []
    const stop = engine.onServingChange((state) => { heard.push(state.shares.map((s) => `${s.online}`).join(',')) })
    const { cid } = await engine.publishShare({ kind: 'files', entries: [entry('a.txt', 'hello')] })
    await engine.setOnline(cid, false)
    expect((await keep.meta(cid))!.online).toBe(false)
    await engine.setOnline(cid, true)
    expect(heard.at(-1)).toBe('true')
    expect(heard).toContain('false')
    await engine.deleteKept(cid)
    expect(await keep.meta(cid)).toBeNull()
    expect(engine.servingState().shares).toEqual([])
    stop()
    const count = heard.length
    await engine.publishShare({ kind: 'files', entries: [entry('b.txt', 'bee')] })
    expect(heard.length).toBe(count)
  })

  it('lists the kept shares, newest first, and exports one as a CAR file that checks out', async () => {
    runtime()
    const first = await engine.publishShare({ kind: 'files', entries: [entry('a.txt', 'one')] })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await engine.publishShare({ kind: 'folder', entries: [entry('docs/b.txt', 'two')] })
    expect((await engine.keptShares()).map((m) => m.cid)).toEqual([second.cid, first.cid])
    const car = await engine.exportCar(second.cid)
    const blocks = await readCar(new Uint8Array(await car.arrayBuffer()), second.cid)
    expect(blocks.size).toBeGreaterThanOrEqual(3)
    await expect(engine.exportCar('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku')).rejects.toThrow('not kept')
  })

  it('opens a share kept here from the runtime, without asking a gateway, even when it is the first thing the page does', async () => {
    const { serving } = runtime()
    const { cid } = await engine.publishShare({ kind: 'files', entries: [entry('a.txt', 'hello'), entry('d/b.txt', 'bee')] })
    vi.stubGlobal('fetch', async () => { throw new Error('no network') })
    const opened = await engine.openShare(cid)
    expect(opened.entries.map((e) => e.path)).toEqual(['a.txt', 'd/b.txt'])
    expect(await (await engine.readPublicFile(opened, 'd/b.txt', {})).text()).toBe('bee')
    expect((await engine.zipPublic(opened, {})).size).toBeGreaterThan(10)
    await serving.close()
  })

  it('keeps a share elsewhere from the kept bytes, later', async () => {
    runtime()
    const { cid } = await engine.publishShare({ kind: 'files', entries: [entry('a.txt', 'hello')] })
    vi.stubGlobal('fetch', async () => new Response(`{"Name":"share","Hash":"${cid}"}\n`))
    const steps: string[] = []
    expect(await engine.pinElsewhere(cid, KUBO, { onProgress: (p) => steps.push(p.step) })).toEqual({ label: 'IPFS Desktop or Kubo (127.0.0.1:5001)', ok: true })
    expect(steps).toEqual(['send', 'check'])
  })

  it('says how much of the site\'s storage the shares take, and whether the browser will keep it', async () => {
    runtime()
    await engine.publishShare({ kind: 'files', entries: [entry('a.txt', 'hello')] })
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ usage: 5000, quota: 1_000_000 }), persisted: async () => true, persist: async () => true } })
    const info = await engine.storageInfo()
    expect(info).toMatchObject({ used: 5000, quota: 1_000_000, persisted: true, durable: false })
    expect(info.kept).toBeGreaterThan(0)
    vi.stubGlobal('navigator', {})
    expect(await engine.storageInfo()).toMatchObject({ used: 0, quota: 0, persisted: false })
  })

  it('asks the browser to keep the storage before the first share, and refuses a share that cannot fit', async () => {
    runtime()
    const persist = vi.fn(async () => true)
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ usage: 0, quota: 1_000_000_000 }), persisted: async () => false, persist } })
    await engine.publishShare({ kind: 'files', entries: [entry('a.txt', 'hello')] })
    expect(persist).toHaveBeenCalled()
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ usage: 990_000_000, quota: 1_000_000_000 }), persisted: async () => true, persist } })
    await expect(engine.publishShare({ kind: 'files', entries: [{ path: 'big', file: new Blob([new Uint8Array(5_000_000)]) }] })).rejects.toThrow(/left for Share/)
  })
})

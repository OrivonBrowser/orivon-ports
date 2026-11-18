// node-start.js, run as the browser runs it: in a realm that holds a fake window and document. It starts the node, gives the
// module entry back its type, and answers the page's calls to the desktop's kubo port from the node's own socket.
import { describe, expect, it, vi } from 'vitest'
import pin from '../build/node-bundle-pin.mjs'
import { CONTENT_ADDRESS, type FakeNode, KEY, attributes, load, node, settle, source } from './node-start-support.js'

describe('the node', () => {
  it('is started with the ports of the manifest, the key the bridge made, the page\'s origin and the Worker beside the page', async () => {
    const run = load()
    await run.state.ready
    expect(run.started).toEqual([{ authKey: KEY, ports: { rpc: 9138, gateway: 6473, kubo: 50019, nodeApi: 50119, p2p: 4001 }, origins: ['https://5chan.test'], serverPath: '/node/server.mjs' }])
    expect(run.state.handle).not.toBeNull()
    expect(run.state.error).toBeNull()
  })

  it('takes the key from this origin\'s storage on a page the bridge did not run on, such as the dashboard', async () => {
    const run = load({ window: { pkcRpcAuthKey: undefined }, storage: { 'orivon.pkcRpcAuthKey': 'a'.repeat(40) } })
    await run.state.ready
    expect(run.started[0]?.['authKey']).toBe('a'.repeat(40))
  })

  it('says so, and starts nothing, when there is no key yet', async () => {
    const run = load({ window: { pkcRpcAuthKey: undefined } })
    expect(await run.state.ready).toBeNull()
    expect(run.state.error).toMatch(/no node key yet/)
    expect(run.started).toEqual([])
  })

  it('settles with null and the reason, never rejects, when the node does not start', async () => {
    const run = load({ startBitsocialNode: async () => { throw new Error('Bitsocial Node could not start (rpc): listen EADDRINUSE') } })
    expect(await run.state.ready).toBeNull()
    expect(run.state.error).toContain('EADDRINUSE')
    expect(run.warn).toHaveBeenCalledWith(expect.stringContaining('EADDRINUSE'))
  })

  it('starts again after a pause when a start fails, and settles with the handle once one succeeds', async () => {
    let tries = 0
    const run = load({ startBitsocialNode: async () => { tries++; if (tries < 3) throw new Error('database is locked'); return node() } })
    const handle = await run.state.ready
    expect(handle).not.toBeNull()
    expect(tries).toBe(3)
    expect(run.delays).toEqual([4_000, 8_000])
    expect(run.state.error).toBeNull()
  })

  it('gives up after the last pause, with the last reason, having started five times', async () => {
    let tries = 0
    const run = load({ startBitsocialNode: async () => { tries++; throw new Error(`database is locked ${String(tries)}`) } })
    expect(await run.state.ready).toBeNull()
    expect(tries).toBe(5)
    expect(run.delays).toEqual([4_000, 8_000, 16_000, 30_000])
    expect(run.state.error).toContain('database is locked 5')
  })

  it('says the page module did not load when BitsocialNodeClient is missing', async () => {
    const run = load({ window: { BitsocialNodeClient: undefined } })
    expect(await run.state.ready).toBeNull()
    expect(run.state.error).toBe('node-client.js did not load')
  })

  it.each([['not isolated', { crossOriginIsolated: false }], ['without the file API', { orivon: { version: 0 } }], ['without its permissions', { orivon: { version: 0, fs: {} } }], ['outside Orivon', { orivon: undefined }]])('starts nothing on a page %s, which has not been given its permissions yet', async (_name, change) => {
    const run = load({ window: change })
    expect(await run.state.ready).toBeNull()
    expect(run.started).toEqual([])
    expect(run.state.error).toMatch(/permissions/)
    expect(run.warn).not.toHaveBeenCalled()
  })
})

describe('the held module entry', () => {
  it('is replaced by a module script with every attribute it had as soon as the page is parsed, on a first launch from a content address, before the node has answered', async () => {
    let answer: (value: FakeNode) => void = () => {}
    const run = load({ origin: CONTENT_ADDRESS, startBitsocialNode: () => new Promise<FakeNode>((resolve) => { answer = resolve }) })
    await settle()
    expect(run.state.handle).toBeNull()
    expect(run.storage).toEqual({})
    expect(run.replaced.map((script) => script.attributes)).toEqual([{ type: 'module', crossorigin: '', src: './assets/index-ABC.js' }])
    answer(node())
    await settle()
    expect(run.replaced).toHaveLength(1)
  })

  it('waits for the document to be parsed on a content address too, and is released then, while the node is still starting', async () => {
    const run = load({ origin: CONTENT_ADDRESS, loading: true, startBitsocialNode: () => new Promise<FakeNode>(() => {}) })
    await settle()
    expect(run.replaced).toEqual([])
    run.listeners.get('DOMContentLoaded')?.()
    await settle()
    expect(run.replaced).toHaveLength(1)
    expect(run.state.handle).toBeNull()
  })

  it('is released when the node did not start, so the app shows its own connection error', async () => {
    const run = load({ origin: CONTENT_ADDRESS, startBitsocialNode: async () => { throw new Error('no') } })
    await settle()
    expect(run.replaced).toHaveLength(1)
  })

  it('is released at once, on a first launch, while a failed start is retried, and not again when a retry has the node up', async () => {
    let tries = 0
    let succeed: (value: FakeNode) => void = () => {}
    const run = load({ origin: CONTENT_ADDRESS, startBitsocialNode: () => { tries++; return tries < 3 ? Promise.reject(new Error('the grant authorising this operation was withdrawn')) : new Promise<FakeNode>((resolve) => { succeed = resolve }) } })
    await settle()
    expect(tries).toBe(3)
    expect(run.replaced).toHaveLength(1)
    expect(run.state.handle).toBeNull()
    succeed(node())
    expect(await run.state.ready).not.toBeNull()
    await settle()
    expect(run.replaced).toHaveLength(1)
  })

  it('is released when the last retry has failed, so the app shows its own connection error', async () => {
    const run = load({ origin: CONTENT_ADDRESS, startBitsocialNode: async () => { throw new Error('database is locked') } })
    expect(await run.state.ready).toBeNull()
    await settle()
    expect(run.replaced).toHaveLength(1)
  })

  it('says what it waits for, on a page with no bundle to release (the node dashboard), once the wait is noticeable, and takes the line away when the node has answered', async () => {
    let answer: (value: FakeNode) => void = () => {}
    const appended: Array<{ textContent: string, remove: () => void, removed: boolean }> = []
    const body = { append: (element: { textContent: string, remove: () => void, removed: boolean }) => { appended.push(element) } }
    const run = load({ origin: CONTENT_ADDRESS, entries: 0, body, startBitsocialNode: () => new Promise<FakeNode>((resolve) => { answer = resolve }) })
    await settle()
    expect(run.delays).toContain(1_500)
    for (const noticed of run.noticeable) noticed()
    await settle()
    expect(appended.map((element) => element.textContent)).toEqual(['Starting your Bitsocial node...'])
    answer(node())
    await settle()
    expect(appended[0]?.removed).toBe(true)
  })

  it('draws no line on a page whose bundle was released at once, since the app is shown while the node starts', async () => {
    const appended: unknown[] = []
    const run = load({ origin: CONTENT_ADDRESS, body: { append: (element: unknown) => { appended.push(element) } }, startBitsocialNode: () => new Promise<FakeNode>(() => {}) })
    await settle()
    for (const noticed of run.noticeable) noticed()
    await settle()
    expect(appended).toEqual([])
    expect(run.replaced).toHaveLength(1)
  })

  it('draws no line when the node answers before the wait is noticeable', async () => {
    const appended: unknown[] = []
    const run = load({ body: { append: (element: unknown) => { appended.push(element) } } })
    await run.state.ready
    await settle()
    for (const noticed of run.noticeable) noticed()
    await settle()
    expect(appended).toEqual([])
    expect(run.replaced).toHaveLength(1)
  })

  it('is released at once on a page that has no permissions yet, and outside Orivon', async () => {
    for (const window of [{ orivon: { version: 0 } }, { orivon: undefined }, { crossOriginIsolated: false }]) {
      const run = load({ window })
      await settle()
      expect(run.replaced).toHaveLength(1)
    }
  })

  it('waits for the document to be parsed, so an entry later in the page is not missed', async () => {
    const run = load({ loading: true })
    await settle()
    expect(run.replaced).toEqual([])
    run.listeners.get('DOMContentLoaded')?.()
    await settle()
    expect(run.replaced).toHaveLength(1)
  })
})

describe('fetch', () => {
  const KUBO = 'http://localhost:50019/api/v0'

  it('answers a call to the desktop\'s kubo port from the node\'s own socket, whichever way the address is spelled, and never sends it to the port', async () => {
    const run = load()
    const handle = (await run.state.ready) as FakeNode
    const signal = new AbortController().signal
    const answer = await run.fetch(`${KUBO}/swarm/peers?direction=true&latency=true`, { method: 'POST', signal })
    expect(await answer.json()).toEqual({ ID: 'peer' })
    expect(handle.api).toHaveBeenCalledWith('swarm/peers', { query: '?direction=true&latency=true', signal })
    await run.fetch('http://127.0.0.1:50019/api/v0/id', { method: 'POST' })
    expect(handle.api).toHaveBeenLastCalledWith('id', { query: '', signal: undefined })
    await run.fetch({ url: `${KUBO}/stats/bw`, signal })
    expect(handle.api).toHaveBeenLastCalledWith('stats/bw', { query: '', signal })
    await run.fetch(new URL(`${KUBO}/repo/stat`))
    expect(handle.api).toHaveBeenLastCalledWith('repo/stat', { query: '', signal: undefined })
    expect(run.realFetch).not.toHaveBeenCalled()
  })

  it('leaves every other address to the page\'s own fetch, the node\'s socket and a loopback port that is not kubo\'s among them', async () => {
    const run = load()
    await run.state.ready
    for (const url of ['https://catbox.moe/user/api.php', 'http://localhost:6473/ipfs/bafy', 'http://localhost:9138/', 'http://localhost:50020/api/v0/id', 'http://example.com:50019/api/v0/id', '/relative']) {
      expect(await (await run.fetch(url)).text(), url).toBe('real')
    }
    expect(run.realFetch).toHaveBeenCalledTimes(6)
  })

  it('answers a path of the kubo port that is not the API, such as its web UI, with 404 and no request', async () => {
    const run = load()
    const handle = (await run.state.ready) as FakeNode
    const answer = await run.fetch('http://localhost:50019/webui/')
    expect(answer.status).toBe(404)
    expect(handle.api).not.toHaveBeenCalled()
    expect(run.realFetch).not.toHaveBeenCalled()
  })

  it('waits for the node when it is called before the node answers', async () => {
    let answer: (value: FakeNode) => void = () => {}
    const run = load({ startBitsocialNode: () => new Promise<FakeNode>((resolve) => { answer = resolve }) })
    const pending = run.fetch(`${KUBO}/id`)
    let settled = false
    void pending.then(() => { settled = true })
    await settle()
    expect(settled).toBe(false)
    answer(node())
    expect((await pending).status).toBe(200)
  })

  it('answers 503 with the reason, in kubo\'s error body, when the node is not running', async () => {
    const run = load({ startBitsocialNode: async () => { throw new Error('the Worker ended') } })
    const answer = await run.fetch(`${KUBO}/id`)
    expect(answer.status).toBe(503)
    expect(await answer.json()).toEqual({ Message: expect.stringContaining('the Worker ended') as unknown, Code: 0, Type: 'error' })
    expect((await load({ window: { orivon: { version: 0 } } }).fetch(`${KUBO}/id`)).status).toBe(503)
  })
})

describe("the node's files", () => {
  const ORIGIN = 'https://bafybeitestcid.ipfs.orivon'
  /** What the Worker and the node load at start, from the bundle's own pin: everything under `node/` (the Worker's loader and its packed script, the SQLite engine) and every part of the node's program. */
  const LOADED_FILES = pin.files.filter((file) => file.path.startsWith('node/') || file.path.startsWith('bin/ipfs-node.p2/'))
  const LOADED = LOADED_FILES.map((file) => file.path).sort()
  const SIZE = 12
  /** The pauses a test of the files does not count: the page's own wait (1.5 s) and the reads' stall timers (330 s). */
  const pauses = (run: { delays: number[] }) => run.delays.filter((ms) => ms !== 330_000 && ms !== 1_500)

  /** An answer of 12 bytes: whole, or 4 bytes and then a broken connection (`cut`), or 4 bytes and then its end (`short`). */
  function answer (how: 'whole' | 'cut' | 'short'): Response {
    let sent = false
    const stream = new ReadableStream<Uint8Array>({
      pull (controller) {
        if (!sent) { sent = true; controller.enqueue(new Uint8Array(how === 'whole' ? SIZE : 4)); return }
        if (how === 'cut') controller.error(new TypeError('network error')); else controller.close()
      }
    })
    return new Response(stream, { status: 200, headers: { 'content-length': String(SIZE) } })
  }

  /** A page fetch that answers each path with what `plan` says for that read of it (a status for an answer with no body), and whole once the plan has run out. */
  function served (plan: Record<string, Array<'whole' | 'cut' | 'short' | number>> = {}) {
    const reads: string[] = []
    const fetch = vi.fn(async (input: unknown, _init?: unknown) => {
      const path = new URL(String(input)).pathname.slice(1)
      reads.push(path)
      const next = plan[path]?.shift() ?? 'whole'
      return typeof next === 'number' ? new Response('no', { status: next }) : answer(next)
    })
    return { reads, fetch }
  }

  /** A node start that fails its first `failures` times, as the node client's does once its 150 s are spent, and says in `events` how many reads of the page had been made at each start. */
  function failing (failures: number, page: { reads: string[] }) {
    const events: string[] = []
    const start = async (): Promise<FakeNode> => {
      events.push(`start after ${String(page.reads.length)} reads`)
      if (events.length <= failures) throw new Error('Bitsocial Node did not start within 150 seconds')
      return node()
    }
    return { events, start }
  }

  it("lists the files of the node bundle's pin that the fork loads, with their sizes", () => {
    const block = /const NODE_FILES = \[([\s\S]*?)\n  \]/.exec(source)?.[1] ?? ''
    const listed = [...block.matchAll(/\['([^']+)', ([0-9_]+)\]/g)].map((one) => [one[1], Number((one[2] as string).replaceAll('_', ''))])
    expect(listed.sort()).toEqual(LOADED_FILES.map((file) => [file.path, file.bytes]).sort())
  })

  it.each([ORIGIN, 'https://5chan.orivonstack.eth'])('starts the node at once and reads no file when the first start succeeds, on %s', async (origin) => {
    const page = served()
    const run = load({ origin, window: { fetch: page.fetch } })
    expect(await run.state.ready).not.toBeNull()
    expect(run.started).toHaveLength(1)
    expect(page.fetch).not.toHaveBeenCalled()
    expect(pauses(run)).toEqual([])
    expect(run.warn).not.toHaveBeenCalled()
    expect(run.state.error).toBeNull()
  })

  it.each([ORIGIN, 'https://5chan.orivonstack.eth'])('reads every file the Worker and the node load, whole, after a first start that failed, and starts again with no pause, on %s', async (origin) => {
    const page = served()
    const { events, start } = failing(1, page)
    const run = load({ origin, window: { fetch: page.fetch }, startBitsocialNode: start })
    expect(await run.state.ready).not.toBeNull()
    expect([...page.reads].sort()).toEqual(LOADED)
    expect(events).toEqual(['start after 0 reads', `start after ${String(LOADED.length)} reads`])
    expect(page.fetch.mock.calls.every(([input, init]) => String(input).startsWith(`${origin}/`) && (init as { cache?: string }).cache === 'no-store')).toBe(true)
    expect(pauses(run)).toEqual([])
    expect(run.warn.mock.calls.map(([line]) => line)).toEqual(["[5chan] the Bitsocial node did not start (Bitsocial Node did not start within 150 seconds); reading its files before it is started again"])
    expect(run.state.error).toBeNull()
  })

  it('reads the files once: a second start that fails pauses as it always did and reads nothing more', async () => {
    const page = served()
    const { events, start } = failing(2, page)
    const run = load({ origin: ORIGIN, window: { fetch: page.fetch }, startBitsocialNode: start })
    expect(await run.state.ready).not.toBeNull()
    expect(events).toEqual(['start after 0 reads', `start after ${String(LOADED.length)} reads`, `start after ${String(LOADED.length)} reads`])
    expect(page.reads).toHaveLength(LOADED.length)
    expect(pauses(run)).toEqual([8_000])
  })

  it('reads a file again, after a pause, when a read is cut or ends short, and starts the node again once every file came whole', async () => {
    const page = served({ 'node/server.mjs': ['cut'], 'bin/ipfs-node.p2/ipfs-node.core.wasm.deflate': ['short', 'cut'] })
    const { events, start } = failing(1, page)
    const run = load({ origin: ORIGIN, window: { fetch: page.fetch }, startBitsocialNode: start })
    expect(await run.state.ready).not.toBeNull()
    expect(page.reads.filter((path) => path === 'node/server.mjs')).toHaveLength(2)
    expect(page.reads.filter((path) => path === 'bin/ipfs-node.p2/ipfs-node.core.wasm.deflate')).toHaveLength(3)
    expect(events[1]).toBe(`start after ${String(LOADED.length + 3)} reads`)
    expect(pauses(run)).toEqual([2_000, 2_000, 4_000])
    expect(run.warn.mock.calls.map(([line]) => line).slice(1)).toEqual([
      '[5chan] reading node/server.mjs: try 1 failed after 4 bytes (network error); trying again in 2 s',
      '[5chan] reading bin/ipfs-node.p2/ipfs-node.core.wasm.deflate: try 1 failed after 4 bytes (the answer ended at 4 of 12 bytes); trying again in 2 s',
      '[5chan] reading bin/ipfs-node.p2/ipfs-node.core.wasm.deflate: try 2 failed after 4 bytes (network error); trying again in 4 s'
    ])
    expect(run.state.error).toBeNull()
  })

  it('asks again when a file is answered with a server error, and lets go a file this build does not have', async () => {
    const page = served({ 'node/sqlite3.wasm': [503, 502], 'bin/ipfs-node.p2/ipfs-node.core4.wasm': [404] })
    const run = load({ origin: ORIGIN, window: { fetch: page.fetch }, startBitsocialNode: failing(1, page).start })
    expect(await run.state.ready).not.toBeNull()
    expect(page.reads.filter((path) => path === 'node/sqlite3.wasm')).toHaveLength(3)
    expect(page.reads.filter((path) => path === 'bin/ipfs-node.p2/ipfs-node.core4.wasm')).toHaveLength(1)
    expect(run.warn.mock.calls.map(([line]) => line).slice(1)).toEqual([
      '[5chan] reading node/sqlite3.wasm: try 1 failed after 0 bytes (answered 503); trying again in 2 s',
      '[5chan] reading node/sqlite3.wasm: try 2 failed after 0 bytes (answered 502); trying again in 4 s'
    ])
  })

  it('ends a read that hears nothing for five and a half minutes, and reads the file again', async () => {
    let reads = 0
    const stuck = vi.fn(async (_input: unknown, init?: { signal?: AbortSignal }) => {
      reads++
      if (reads > 1) return answer('whole')
      return await new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }) })
    })
    const run = load({ origin: ORIGIN, window: { fetch: stuck }, startBitsocialNode: failing(1, { reads: [] }).start })
    await settle()
    expect(run.stalls).toHaveLength(1)
    run.stalls[0]?.()
    expect(await run.state.ready).not.toBeNull()
    expect(run.warn.mock.calls[1]?.[0]).toBe('[5chan] reading node/server.mjs: try 1 failed after 0 bytes (nothing came for 330 s); trying again in 2 s')
  })

  it('gives up on a big file when its time is spent, which is its size at 20 kB/s, settles with that cause as the error, starts no more nodes, and still releases the bundle', async () => {
    // The script is packed, 5.5 MB, which 20 kB/s reads inside the ten minutes: the rule that a big file is given its size at that rate is run on a list that holds the script as it was unpacked.
    const big = source.replace(/\['node\/server\.bundle\.js\.deflate', [0-9_]+\]/, "['node/server.bundle.js.deflate', 30_200_038]")
    expect(big).not.toBe(source)
    const page = served({ 'node/server.bundle.js.deflate': Array.from({ length: 200 }, () => 'cut' as const) })
    const { events, start } = failing(1, page)
    const run = load({ origin: ORIGIN, window: { fetch: page.fetch }, startBitsocialNode: start, source: big })
    expect(await run.state.ready).toBeNull()
    expect(run.state.error).toMatch(/^the node's file node\/server\.bundle\.js\.deflate could not be read: network error \(try \d+, 4 bytes received, \d+ s after the first read of it began\)$/)
    // 30.2 MB at 20 kB/s is 1510 s: pauses of 2, 4, 8, 16 and then 30 s each are spent when the next one would pass it.
    const spent = Number(/, (\d+) s after/.exec(String(run.state.error))?.[1])
    expect(spent).toBeGreaterThanOrEqual(1_450)
    expect(spent).toBeLessThanOrEqual(1_510)
    expect(events).toEqual(['start after 0 reads'])
    await settle()
    expect(run.replaced).toHaveLength(1)
    expect(page.reads.filter((path) => path !== 'node/server.mjs').every((path) => path === 'node/server.bundle.js.deflate')).toBe(true)
    expect(run.warn).toHaveBeenLastCalledWith(expect.stringContaining("[5chan] the Bitsocial node did not start: the node's file node/server.bundle.js.deflate could not be read"))
  })

  it('gives up on a small file after ten minutes', async () => {
    const page = served({ 'node/sqlite3.wasm': Array.from({ length: 200 }, () => 503 as const) })
    const { events, start } = failing(1, page)
    const run = load({ origin: ORIGIN, window: { fetch: page.fetch }, startBitsocialNode: start })
    expect(await run.state.ready).toBeNull()
    const spent = Number(/, (\d+) s after/.exec(String(run.state.error))?.[1])
    expect(run.state.error).toMatch(/^the node's file node\/sqlite3\.wasm could not be read: answered 503 \(try \d+, 0 bytes received/)
    expect(spent).toBeGreaterThanOrEqual(540)
    expect(spent).toBeLessThanOrEqual(600)
    expect(events).toEqual(['start after 0 reads'])
  })

  it('says which file it waits for while the file is silent, as the verifier is until it has the whole of a file', async () => {
    const shown: Array<{ textContent: string }> = []
    const body = { append: (element: { textContent: string }) => { shown.push(element) } }
    const silent = vi.fn(async (_input: unknown, init?: { signal?: AbortSignal }) => await new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }) }))
    const run = load({ origin: ORIGIN, entries: 0, window: { fetch: silent }, body, startBitsocialNode: failing(1, { reads: [] }).start })
    await settle()
    run.noticeable[0]?.()
    await settle()
    expect(shown[0]?.textContent).toBe(`Starting your Bitsocial node... loading node/server.mjs (1 of ${String(LOADED.length)})`)
  })

  it('says which file it is on in the wait the page shows, and its first words again once every file is read', async () => {
    const shown: Array<{ textContent: string }> = []
    const body = { append: (element: { textContent: string }) => { shown.push(element) } }
    let breakRead: () => void = () => {}
    let first = true
    const held = vi.fn(async (input: unknown, _init?: unknown) => {
      if (new URL(String(input)).pathname !== '/node/server.mjs' || !first) return answer('whole')
      first = false
      const stream = new ReadableStream<Uint8Array>({ start (controller) { controller.enqueue(new Uint8Array(4)); breakRead = () => { controller.error(new TypeError('network error')) } } })
      return new Response(stream, { status: 200, headers: { 'content-length': String(SIZE) } })
    })
    const run = load({ origin: ORIGIN, entries: 0, window: { fetch: held }, body, startBitsocialNode: failing(1, { reads: [] }).start })
    await settle()
    run.noticeable[0]?.()
    await settle()
    expect(shown).toHaveLength(1)
    expect(shown[0]?.textContent).toBe('Starting your Bitsocial node... loading node/server.mjs: 0.0 of 0.0 MB')
    breakRead()
    await run.state.ready
    expect(shown[0]?.textContent).toBe('Starting your Bitsocial node...')
  })

  it.each(['http://127.0.0.1:8080', 'http://localhost:3000', 'https://5chan.test', 'https://example.com'])('reads nothing on a page served from %s, even after a start that failed: the next start comes after its pause', async (origin) => {
    const page = served()
    const run = load({ origin, window: { fetch: page.fetch }, startBitsocialNode: failing(1, page).start })
    expect(await run.state.ready).not.toBeNull()
    expect(page.fetch).not.toHaveBeenCalled()
    expect(pauses(run)).toEqual([4_000])
  })
})

describe('outside Orivon', () => {
  const PLAIN: Array<[string, unknown]> = [
    ['no window.orivon', undefined],
    ['a null window.orivon', null],
    ['an orivon with no numeric version', { fs: { readFile () {} } }],
    ['an orivon whose version is text', { version: '0', fs: { readFile () {} } }]
  ]

  it.each(PLAIN)('leaves the page\'s fetch as it is on a page with %s, so a call to the kubo port is not answered by a node', async (_name, orivon) => {
    const run = load({ window: { orivon } })
    expect(run.window['fetch']).toBe(run.realFetch)
    expect(await (await run.fetch('http://localhost:50019/api/v0/id')).text()).toBe('real')
    expect(await run.state.ready).toBeNull()
    expect(run.started).toEqual([])
  })

  it.each(PLAIN)('still gives the module entry its type back on a page with %s, so the app runs', async (_name, orivon) => {
    const run = load({ window: { orivon } })
    await settle()
    expect(run.replaced.map((script) => script.attributes)).toEqual([{ type: 'module', crossorigin: '', src: './assets/index-ABC.js' }])
  })
})

describe('outside Orivon, the page\'s WebSocket', () => {
  it.each([undefined, null, { fs: { readFile () {} } }])('is the one the browser gave it on a page with the orivon %j', (orivon) => {
    class PageSocket {}
    const run = load({ window: { orivon, WebSocket: PageSocket } })
    expect(run.window['WebSocket']).toBe(PageSocket)
  })

  it('is wrapped on a page of Orivon', () => {
    class PageSocket {}
    const run = load({ window: { WebSocket: PageSocket } })
    expect(run.window['WebSocket']).not.toBe(PageSocket)
  })
})

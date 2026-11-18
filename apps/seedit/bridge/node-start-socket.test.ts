// node-start.js, run as the browser runs it, while the node starts: when the bundle is given back its type, and the RPC socket the bundle opens.
import { describe, expect, it } from 'vitest'
import { CONTENT_ADDRESS, type FakeNode, KEY, load, node, settle, source } from './node-start-support.js'

describe('the release of the bundle before the node has answered', () => {
  const MARK_KEY = 'orivon.bitsocialNodeFiles'
  const WORKER_BEGAN = '[bitsocial-node] node starting'
  const waitingNode = () => {
    let answer: (value: FakeNode) => void = () => {}
    return { start: () => new Promise<FakeNode>((resolve) => { answer = resolve }), answer: (value: FakeNode = node()) => { answer(value) } }
  }

  it('is at once, on a page served from this computer', async () => {
    const run = load({ startBitsocialNode: waitingNode().start })
    await settle()
    expect(run.replaced).toHaveLength(1)
    expect(run.state.handle).toBeNull()
  })

  it.each([['a first launch, with no mark in the page\'s storage', {}], ['a page whose storage holds a mark an earlier build left', { [MARK_KEY]: 'node/server.mjs:1' }]])('is at once, on a content address, on %s, as soon as the page is parsed and before the Worker has written a line', async (_name, storage) => {
    const run = load({ origin: CONTENT_ADDRESS, storage, startBitsocialNode: waitingNode().start })
    await settle()
    expect(run.replaced).toHaveLength(1)
    expect(run.state.handle).toBeNull()
  })

  it('is once, on a content address that is a first launch: the line the Worker writes when it begins to start the node does not release it again', async () => {
    const run = load({ origin: CONTENT_ADDRESS, startBitsocialNode: waitingNode().start })
    await settle()
    expect(run.replaced).toHaveLength(1)
    run.console.log(WORKER_BEGAN)
    run.console.warn(WORKER_BEGAN)
    await settle()
    expect(run.replaced).toHaveLength(1)
    expect(run.state.handle).toBeNull()
  })

  it('leaves the console alone, whatever the page: a first launch from a content address, a page served from this computer, a page with no permissions, outside Orivon', () => {
    for (const run of [load(), load({ origin: CONTENT_ADDRESS }), load({ origin: CONTENT_ADDRESS, window: { orivon: { version: 0 } } }), load({ origin: CONTENT_ADDRESS, window: { orivon: undefined } })]) {
      expect(run.console.log).toBe(run.logged)
    }
  })

  it('is not made for a page that has no bundle to release, the node dashboard, which keeps saying what it waits for', async () => {
    const appended: Array<{ textContent: string }> = []
    const run = load({ entries: 0, body: { append: (element: { textContent: string }) => { appended.push(element) } }, startBitsocialNode: waitingNode().start })
    await settle()
    for (const noticed of run.noticeable) noticed()
    await settle()
    expect(appended.map((element) => element.textContent)).toEqual(['Starting your Bitsocial node...'])
  })

  it('leaves nothing in the page\'s storage when the node answers, and when the node did not start', async () => {
    const answered = load({ origin: CONTENT_ADDRESS })
    await answered.state.ready
    expect(answered.storage).toEqual({})
    const failed = load({ origin: CONTENT_ADDRESS, startBitsocialNode: async () => { throw new Error('no') } })
    expect(await failed.state.ready).toBeNull()
    expect(failed.storage).toEqual({})
  })
})

describe('the RPC socket, while the node starts', () => {
  class Dial {
    static all: Dial[] = []
    readyState = 0
    binaryType = 'blob'
    sent: string[] = []
    closes: Array<[number | undefined, string | undefined]> = []
    listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>()
    constructor (public url: string) { Dial.all.push(this) }
    addEventListener (type: string, listener: (event: Record<string, unknown>) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
    send (data: string) { this.sent.push(data) }
    close (code?: number, reason?: string) { this.closes.push([code, reason]) }
    emit (type: string, event: Record<string, unknown> = {}) {
      if (type === 'open') this.readyState = 1
      if (type === 'close') this.readyState = 3
      for (const listener of this.listeners.get(type) ?? []) listener(event)
    }
  }
  interface PageSocket {
    readyState: number
    url: string
    binaryType: string
    send: (data: string) => void
    close: (code?: number, reason?: string) => void
    addEventListener: (type: string, listener: (event: { data?: string, code?: number }) => void) => void
    onopen: ((event: unknown) => void) | null
    onmessage: ((event: { data: string }) => void) | null
  }
  const RPC = `ws://localhost:9148/${KEY}`
  const dials = (): { WebSocket: typeof Dial } => { Dial.all = []; return { WebSocket: Dial } }
  const socketOf = (run: { window: Record<string, unknown> }) => run.window['WebSocket'] as new (url: string) => PageSocket
  const waitingNode = () => {
    let answer: (value: FakeNode) => void = () => {}
    return { start: () => new Promise<FakeNode>((resolve) => { answer = resolve }), answer: (value: FakeNode = node()) => { answer(value) } }
  }
  /** What the page's socket tells its listeners, in order. */
  const watch = (socket: PageSocket): string[] => {
    const seen: string[] = []
    for (const type of ['open', 'message', 'error', 'close']) {
      socket.addEventListener(type, (event) => { seen.push(type === 'message' ? `message ${String(event.data)}` : type === 'close' ? `close ${String(event.code)}` : type) })
    }
    return seen
  }

  it('is open to the page at once, while the node starts, and the real one is opened, and mirrored, once the node has answered', async () => {
    const waiting = waitingNode()
    const run = load({ window: dials(), startBitsocialNode: waiting.start })
    const socket = new (socketOf(run))(RPC)
    const seen = watch(socket)
    expect(socket.readyState).toBe(0)
    expect(socket.url).toBe(RPC)
    expect(() => { socket.send('too soon') }).toThrow(/CONNECTING/)
    await settle()
    expect(Dial.all).toEqual([])
    expect(socket.readyState).toBe(1)
    expect(seen).toEqual(['open'])
    socket.send('waits')
    waiting.answer()
    await settle()
    expect(Dial.all.map((dial) => dial.url)).toEqual([RPC])
    expect(Dial.all[0]!.sent).toEqual([])
    Dial.all[0]!.emit('open')
    expect(Dial.all[0]!.sent).toEqual(['waits'])
    Dial.all[0]!.emit('message', { data: 'hello' })
    socket.send('ping')
    expect(Dial.all[0]!.sent).toEqual(['waits', 'ping'])
    expect(seen).toEqual(['open', 'message hello'])
  })

  it('calls the handlers the page set as properties as it calls its listeners', async () => {
    const waiting = waitingNode()
    const run = load({ window: dials(), startBitsocialNode: waiting.start })
    const socket = new (socketOf(run))(RPC)
    const seen: string[] = []
    socket.onopen = () => { seen.push('open') }
    socket.onmessage = (event) => { seen.push(event.data) }
    waiting.answer()
    await settle()
    Dial.all[0]!.emit('open')
    Dial.all[0]!.emit('message', { data: 'hi' })
    expect(seen).toEqual(['open', 'hi'])
    socket.onopen = null
    expect(socket.onopen).toBeNull()
  })

  it('hands on the refusal of the real socket when the node did not start, after the open it reported, so the app ends as it does with a node that went away', async () => {
    const run = load({ window: dials(), startBitsocialNode: async () => { throw new Error('no') } })
    const socket = new (socketOf(run))(RPC)
    const seen = watch(socket)
    expect(await run.state.ready).toBeNull()
    await settle()
    expect(Dial.all).toHaveLength(1)
    Dial.all[0]!.emit('error')
    Dial.all[0]!.emit('close', { code: 1006, reason: '', wasClean: false })
    expect(seen).toEqual(['open', 'error', 'close 1006'])
    expect(socket.readyState).toBe(3)
  })

  it('leaves every other socket alone, while the node starts', () => {
    const run = load({ window: dials(), startBitsocialNode: waitingNode().start })
    const Page = socketOf(run)
    const others = ['wss://example.org/socket', 'ws://localhost:9138/key', 'ws://localhost:50129/', 'ws://example.org:9148/key', 'ws://localhost:91480/key', 'ws://localhost:9148']
    const made = others.map((url) => new Page(url))
    expect(Dial.all.map((dial) => dial.url)).toEqual(others)
    made.forEach((socket, index) => { expect(socket).toBe(Dial.all[index]) })
  })

  it('is the browser\'s own socket once the node has answered, and once it failed', async () => {
    for (const startBitsocialNode of [undefined, async () => { throw new Error('no') }]) {
      const run = load({ window: dials(), ...(startBitsocialNode === undefined ? {} : { startBitsocialNode }) })
      await run.state.ready
      await settle()
      const socket = new (socketOf(run))(RPC)
      expect(socket).toBe(Dial.all[0])
    }
  })

  it('is not held on a page that starts no node', () => {
    const run = load({ window: { ...dials(), orivon: { version: 0 } } })
    const socket = new (socketOf(run))(RPC)
    expect(socket).toBe(Dial.all[0])
  })

  it('sends what the page sent while the node started, in order, once the real socket opens', async () => {
    const waiting = waitingNode()
    const run = load({ window: dials(), startBitsocialNode: waiting.start })
    const socket = new (socketOf(run))(RPC)
    const seen = watch(socket)
    await settle()
    socket.send('first')
    socket.send('second')
    expect(Dial.all).toEqual([])
    waiting.answer()
    await settle()
    expect(Dial.all).toHaveLength(1)
    socket.send('third')
    expect(Dial.all[0]!.sent).toEqual([])
    Dial.all[0]!.emit('open')
    expect(Dial.all[0]!.sent).toEqual(['first', 'second', 'third'])
    socket.send('fourth')
    expect(Dial.all[0]!.sent.at(-1)).toBe('fourth')
    expect(seen).toEqual(['open'])
  })

  it('fails when the page closes it while it is held, and opens no real socket afterwards', async () => {
    const waiting = waitingNode()
    const run = load({ window: dials(), startBitsocialNode: waiting.start })
    const socket = new (socketOf(run))(RPC)
    const seen = watch(socket)
    socket.close()
    expect(socket.readyState).toBe(2)
    await settle()
    expect(seen).toEqual(['error', 'close 1006'])
    expect(socket.readyState).toBe(3)
    waiting.answer()
    await settle()
    expect(Dial.all).toEqual([])
  })

  it('ends with the code the page gave when the page closes it after it was reported open', async () => {
    const run = load({ window: dials(), startBitsocialNode: waitingNode().start })
    const socket = new (socketOf(run))(RPC)
    const seen = watch(socket)
    await settle()
    socket.close(1000, 'done')
    await settle()
    expect(seen).toEqual(['open', 'close 1000'])
    expect(Dial.all).toEqual([])
  })

  it('closes the real socket when the page closes it once there is one', async () => {
    const waiting = waitingNode()
    const run = load({ window: dials(), startBitsocialNode: waiting.start })
    const socket = new (socketOf(run))(RPC)
    const seen = watch(socket)
    waiting.answer()
    await settle()
    Dial.all[0]!.emit('open')
    socket.close(1000, 'bye')
    expect(Dial.all[0]!.closes).toEqual([[1000, 'bye']])
    Dial.all[0]!.emit('close', { code: 1000 })
    expect(seen).toEqual(['open', 'close 1000'])
    expect(socket.readyState).toBe(3)
  })

  it('gives the real socket the binary type the page chose, before it is opened and after', async () => {
    const waiting = waitingNode()
    const run = load({ window: dials(), startBitsocialNode: waiting.start })
    const socket = new (socketOf(run))(RPC)
    socket.binaryType = 'arraybuffer'
    waiting.answer()
    await settle()
    expect(Dial.all[0]!.binaryType).toBe('arraybuffer')
    socket.binaryType = 'blob'
    expect(Dial.all[0]!.binaryType).toBe('blob')
  })

  it('asks the node client whether a node answers with the browser\'s own WebSocket, which holds nothing', async () => {
    const run = load({ window: dials() })
    await run.state.ready
    expect(run.dependencies).toEqual([{ WebSocket: Dial }])
  })

  it('has the page load once more when the node answers after the calls that waited have timed out, once in a tab', async () => {
    const waiting = waitingNode()
    const run = load({ window: dials(), startBitsocialNode: waiting.start })
    new (socketOf(run))(RPC)
    run.setNow(300_000)
    waiting.answer()
    await settle()
    expect(run.reload).toHaveBeenCalledTimes(1)
    const again = waitingNode()
    const second = load({ window: dials(), session: run.session, startBitsocialNode: again.start })
    new (socketOf(second))(RPC)
    second.setNow(300_000)
    again.answer()
    await settle()
    expect(second.reload).not.toHaveBeenCalled()
  })

  it('does not load the page again when the node answers within that time, or did not start, or nothing was waiting', async () => {
    const quick = waitingNode()
    const soon = load({ window: dials(), startBitsocialNode: quick.start })
    new (socketOf(soon))(RPC)
    soon.setNow(100_000)
    quick.answer()
    await settle()
    const failed = load({ window: dials(), startBitsocialNode: async () => { throw new Error('no') } })
    new (socketOf(failed))(RPC)
    failed.setNow(300_000)
    await failed.state.ready
    const idle = waitingNode()
    const none = load({ window: dials(), startBitsocialNode: idle.start })
    none.setNow(300_000)
    idle.answer()
    await settle()
    expect([soon.reload, failed.reload, none.reload].map((reload) => reload.mock.calls.length)).toEqual([0, 0, 0])
  })

  it('watches a community the page creates on a socket that was held, and starts it on a socket of its own', async () => {
    const waiting = waitingNode()
    const run = load({ window: dials(), startBitsocialNode: waiting.start })
    const page = new (socketOf(run))(RPC)
    await settle()
    page.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'createCommunity', params: [{}] }))
    waiting.answer()
    await settle()
    Dial.all[0]!.emit('open')
    Dial.all[0]!.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: 7, result: { localCommunity: { address: '12D3KooWabc' } } }) })
    expect(Dial.all).toHaveLength(2)
    Dial.all[1]!.emit('open')
    expect(JSON.parse(Dial.all[1]!.sent[0]!)).toMatchObject({ method: 'startCommunity', params: [{ publicKey: '12D3KooWabc' }] })
  })
})

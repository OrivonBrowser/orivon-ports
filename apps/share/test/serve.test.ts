import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cidFor, parseCid } from '../page/src/ipfs/cid.js'
import { listTree, readFileBlob } from '../page/src/ipfs/dagwalk.js'
import { importTree } from '../page/src/ipfs/unixfs.js'
import { memoryBackend } from '../page/src/keep/backends.js'
import { createKeep } from '../page/src/keep/store.js'
import { closeSession, sessionFor } from '../page/src/receive/session.js'
import { fromBinary, infoHashOf, randomOfferId, randomPeerId, toBinary } from '../page/src/serve/ids.js'
import { createServing } from '../page/src/serve/manager.js'
import { createPool } from '../page/src/serve/pool.js'
import { createSeeder } from '../page/src/serve/seeder.js'
import { joinSwarm } from '../page/src/serve/swarm.js'
import { createTrackerHub, DEFAULT_INTERVAL_S, TRACKERS } from '../page/src/serve/tracker.js'

const text = new TextEncoder()
const PEER_A = toBinary(Uint8Array.from({ length: 20 }, (_, i) => 0x80 + i))
const PEER_B = toBinary(Uint8Array.from({ length: 20 }, (_, i) => 0xf0 - i))
const HASH = toBinary(Uint8Array.from({ length: 20 }, (_, i) => 200 + i))

/** A timer the test turns by hand. */
function manualTimers () {
  let now = 0
  let next = 1
  const pending = new Map<number, { at: number, run: () => void }>()
  return {
    setTimeout: ((run: () => void, ms = 0) => { const id = next++; pending.set(id, { at: now + ms, run }); return id }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => { pending.delete(id) }) as unknown as typeof clearTimeout,
    advance (ms: number) {
      const until = now + ms
      for (;;) {
        const due = [...pending].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        pending.delete(due[0])
        now = Math.max(now, due[1].at)
        due[1].run()
      }
      now = until
    }
  }
}

/** A WebSocket the test drives: what it was sent, and a way to send some back. */
class FakeSocket {
  static all: FakeSocket[] = []
  readyState = 0
  sent: any[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onSend: ((socket: FakeSocket, message: any) => void) | null = null
  constructor (public url: string) {
    FakeSocket.all.push(this)
    queueMicrotask(() => { if (!this.closed) { this.readyState = 1; this.onopen?.() } })
  }

  send (data: string) {
    this.sent.push(JSON.parse(data))
    this.onSend?.(this, JSON.parse(data))
  }

  receive (message: unknown) {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) })
  }

  close () {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    this.onclose?.()
  }
}

/** A tracker: peers announce to it by swarm, and it hands their offers and answers on. */
function fakeTracker () {
  const swarms = new Map<string, Map<string, FakeSocket>>()
  const log: any[] = []
  function handle (socket: FakeSocket, message: any) {
    log.push(message)
    if (message.action !== 'announce') return
    const swarm = swarms.get(message.info_hash) ?? new Map<string, FakeSocket>()
    swarms.set(message.info_hash, swarm)
    if (message.event === 'stopped') { swarm.delete(message.peer_id); return }
    if (message.answer !== undefined) {
      swarm.get(message.to_peer_id)?.receive({ action: 'announce', info_hash: message.info_hash, peer_id: message.peer_id, answer: message.answer, offer_id: message.offer_id })
      return
    }
    swarm.set(message.peer_id, socket)
    const others = [...swarm].filter(([id]) => id !== message.peer_id)
    for (const [index, offer] of (message.offers ?? []).entries()) {
      others[index % Math.max(others.length, 1)]?.[1].receive({ action: 'announce', info_hash: message.info_hash, peer_id: message.peer_id, offer: offer.offer, offer_id: offer.offer_id })
    }
    socket.receive({ action: 'announce', info_hash: message.info_hash, interval: 120, complete: swarm.size, incomplete: 0 })
  }
  class TrackerSocket extends FakeSocket {
    constructor (url: string) {
      super(url)
      this.onSend = handle
    }
  }
  return { WebSocket: TrackerSocket as unknown as typeof WebSocket, swarms, log }
}

class FakeChannel extends EventTarget {
  readyState = 'connecting'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  binaryType = 'blob'
  other: FakeChannel | null = null
  constructor (readonly label: string) { super() }
  send (data: Uint8Array) {
    const peer = this.other
    const copy = data.slice().buffer
    setTimeout(() => { if (peer !== null && peer.readyState === 'open') peer.dispatchEvent(Object.assign(new Event('message'), { data: copy })) }, 0)
  }

  close () {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.dispatchEvent(new Event('close'))
    const peer = this.other
    if (peer !== null && peer.readyState !== 'closed') setTimeout(() => peer.close(), 0)
  }

  open () {
    this.readyState = 'open'
    this.dispatchEvent(new Event('open'))
  }
}

/** WebRTC in memory: an offer names its connection, an answer names both, and setting the answer joins the two. */
function fakeRtc () {
  const registry = new Map<string, any>()
  let counter = 0
  class FakePeerConnection extends EventTarget {
    id = `pc${counter++}`
    iceGatheringState = 'complete'
    connectionState = 'new'
    localDescription: { type: string, sdp: string } | null = null
    channel: FakeChannel | null = null
    offerer = ''
    constructor (public config: unknown) { super(); registry.set(this.id, this) }
    createDataChannel (label: string) { this.channel = new FakeChannel(label); return this.channel }
    async createOffer () { return { type: 'offer', sdp: `offer:${this.id}` } }
    async createAnswer () { return { type: 'answer', sdp: `answer:${this.offerer}:${this.id}` } }
    async setLocalDescription (description: { type: string, sdp: string }) { this.localDescription = description }
    async setRemoteDescription (description: { type: string, sdp: string }) {
      if (description.type === 'offer') { this.offerer = description.sdp.slice('offer:'.length); return }
      const acceptor = registry.get(description.sdp.split(':')[2] ?? '')
      if (acceptor === undefined || this.channel === null) throw new Error('no such connection')
      const theirs = new FakeChannel(this.channel.label)
      this.channel.other = theirs
      theirs.other = this.channel
      setTimeout(() => {
        acceptor.dispatchEvent(Object.assign(new Event('datachannel'), { channel: theirs }))
        this.channel?.open()
        theirs.open()
      }, 0)
    }

    close () { this.connectionState = 'closed' }
  }
  return { RTCPeerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection, registry }
}

const waitFor = async (condition: () => boolean, ms = 3000) => {
  const until = Date.now() + ms
  while (!condition()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

const hubs: { close: () => void }[] = []
const newHub = (peerId: string, WebSocketImpl: typeof WebSocket = FakeSocket as unknown as typeof WebSocket, timers?: ReturnType<typeof manualTimers>) => {
  const hub = createTrackerHub({ peerId, WebSocketImpl, ...(timers ? { timers } : {}) })
  hubs.push(hub)
  return hub
}
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close()
  FakeSocket.all.length = 0
})

describe('the names a swarm goes by', () => {
  it('is the first 20 bytes of the SHA-256 of "orivon-share/1:" and the address, one character to the byte', async () => {
    const cid = 'bafybeiek6rgo53nnksskarhmyk2ussqywifoxhs45j7y3l4mlis5nlqziu'
    const hash = await infoHashOf(cid)
    expect(hash).toHaveLength(20)
    expect(hash).toBe(toBinary(createHash('sha256').update(`orivon-share/1:${cid}`).digest().subarray(0, 20)))
    expect(await infoHashOf('QmY9cxiHqTFoWamkQVkpmmqzBrY3hCBEL2XNu3NtX74Fuu')).toBe(await infoHashOf('bafybeierygapfancqypsshj2jh4oesqczz75r7mplry3tvwucftekwqczq'))
  })

  it('turns bytes to a string and back, and makes ids of 20 bytes', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(fromBinary(toBinary(bytes))).toEqual(bytes)
    const peer = randomPeerId()
    expect(peer).toHaveLength(20)
    expect(peer.startsWith('-OS0100-')).toBe(true)
    expect(randomOfferId()).toHaveLength(20)
    expect(randomOfferId()).not.toBe(randomOfferId())
  })
})

describe('the tracker client', () => {
  function hubWith (timers = manualTimers()) {
    return { hub: newHub(PEER_A, FakeSocket as unknown as typeof WebSocket, timers), timers }
  }
  const member = () => {
    const seen = { announces: [] as string[], offers: [] as any[], answers: [] as any[] }
    return {
      seen,
      handlers: {
        onAnnounce: (send: (params: any) => void, url: string) => { seen.announces.push(url); send({ event: 'started', left: 0, numwant: 0, offers: [] }) },
        onOffer: (offer: any) => { seen.offers.push(offer) },
        onAnswer: (answer: any) => { seen.answers.push(answer) }
      }
    }
  }

  it('asks every public tracker at once and says how many answered', async () => {
    const { hub } = hubWith()
    hub.start()
    expect(FakeSocket.all.map((s) => s.url)).toEqual(TRACKERS)
    expect(TRACKERS).toContain('wss://tracker.files.fm:7073/announce')
    await Promise.resolve()
    expect(hub.state).toEqual({ connected: 4, total: 4 })
    hub.start()
    expect(FakeSocket.all).toHaveLength(4)
  })

  it('announces on each tracker as it opens, with ids as WebTorrent trackers carry them', async () => {
    const { hub } = hubWith()
    const { seen, handlers } = member()
    hub.join(HASH, handlers)
    hub.start()
    await Promise.resolve()
    expect(seen.announces.sort()).toEqual([...TRACKERS].sort())
    expect(FakeSocket.all[0]!.sent[0]).toEqual({ action: 'announce', info_hash: HASH, peer_id: PEER_A, uploaded: 0, downloaded: 0, event: 'started', left: 0, numwant: 0, offers: [] })
  })

  it('hands on an offer with a way to answer it, and an answer to an offer of its own', async () => {
    const { hub } = hubWith()
    const { seen, handlers } = member()
    hub.join(HASH, handlers)
    hub.start()
    await Promise.resolve()
    const socket = FakeSocket.all[0]!
    socket.receive({ action: 'announce', info_hash: HASH, peer_id: PEER_B, offer_id: 'o1', offer: { type: 'offer', sdp: 'v=0' } })
    expect(seen.offers).toHaveLength(1)
    expect(seen.offers[0]).toMatchObject({ peerId: PEER_B, offerId: 'o1', offer: { type: 'offer', sdp: 'v=0' } })
    seen.offers[0].reply({ type: 'answer', sdp: 'v=1' })
    expect(socket.sent.at(-1)).toEqual({ action: 'announce', info_hash: HASH, peer_id: PEER_A, to_peer_id: PEER_B, answer: { type: 'answer', sdp: 'v=1' }, offer_id: 'o1' })
    socket.receive({ action: 'announce', info_hash: HASH, peer_id: PEER_B, offer_id: 'o2', answer: { type: 'answer', sdp: 'v=2' } })
    expect(seen.answers).toEqual([{ peerId: PEER_B, offerId: 'o2', answer: { type: 'answer', sdp: 'v=2' } }])
  })

  it('ignores what is not for it: another swarm, itself, a failure, a message that is not JSON or too large', async () => {
    const { hub } = hubWith()
    const { seen, handlers } = member()
    hub.join(HASH, handlers)
    hub.start()
    await Promise.resolve()
    const socket = FakeSocket.all[0]!
    const offer = { type: 'offer', sdp: 'v=0' }
    socket.receive({ action: 'announce', info_hash: toBinary(new Uint8Array(20)), peer_id: PEER_B, offer_id: 'o', offer })
    socket.receive({ action: 'announce', info_hash: HASH, peer_id: PEER_A, offer_id: 'o', offer })
    socket.receive({ 'failure reason': 'nope', info_hash: HASH })
    socket.receive('not json')
    socket.receive({ action: 'announce', info_hash: HASH, peer_id: PEER_B, offer_id: 'o', offer: { type: 'offer', sdp: 'x'.repeat(20_000) } })
    socket.receive({ action: 'announce', info_hash: HASH, peer_id: PEER_B, offer_id: 'o', offer: { type: 'answer', sdp: 'v=0' } })
    socket.receive({ action: 'announce', info_hash: HASH, peer_id: 5, offer_id: 'o', offer })
    socket.receive(JSON.stringify({ pad: 'x'.repeat(70_000) }))
    expect(seen.offers).toEqual([])
    expect(seen.answers).toEqual([])
  })

  it('announces again when the tracker\'s interval is up, not sooner than 30 s, and by default after two minutes', async () => {
    const { hub, timers } = hubWith()
    const { seen, handlers } = member()
    hub.join(HASH, handlers)
    hub.start()
    await Promise.resolve()
    const url = TRACKERS[0]!
    const count = () => seen.announces.filter((u) => u === url).length
    const first = count()
    const socket = FakeSocket.all.find((s) => s.url === url)!
    timers.advance(DEFAULT_INTERVAL_S * 1000 - 1)
    expect(count()).toBe(first)
    timers.advance(1)
    expect(count()).toBe(first + 1)
    socket.receive({ action: 'announce', info_hash: HASH, interval: 5 })
    timers.advance(29_999)
    expect(count()).toBe(first + 1)
    timers.advance(1)
    expect(count()).toBe(first + 2)
    socket.receive({ action: 'announce', info_hash: HASH, interval: 90_000 })
    timers.advance(599_999)
    expect(count()).toBe(first + 2)
    timers.advance(1)
    expect(count()).toBe(first + 3)
  })

  it('calls a tracker that dropped again after a wait that doubles to a minute, and announces once it is back', async () => {
    const { hub, timers } = hubWith()
    const { seen, handlers } = member()
    hub.join(HASH, handlers)
    hub.start()
    await Promise.resolve()
    const random = Math.random
    Math.random = () => 0.5
    try {
      const url = TRACKERS[0]!
      const waits = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]
      for (const wait of waits) {
        const socket = [...FakeSocket.all].reverse().find((s) => s.url === url)!
        const before = FakeSocket.all.length
        socket.close()
        timers.advance(wait - 1)
        expect(FakeSocket.all.length, `before ${wait}`).toBe(before)
        timers.advance(1)
        expect(FakeSocket.all.length, `after ${wait}`).toBe(before + 1)
      }
      await Promise.resolve()
      expect(seen.announces.filter((u) => u === url).length, 'announced on the new socket').toBeGreaterThan(1)
    } finally {
      Math.random = random
    }
  })

  it('tells the trackers it left, and stops calling them when closed', async () => {
    const { hub, timers } = hubWith()
    const { handlers } = member()
    const leave = hub.join(HASH, handlers)
    hub.start()
    await Promise.resolve()
    leave()
    expect(FakeSocket.all[0]!.sent.at(-1)).toMatchObject({ action: 'announce', info_hash: HASH, event: 'stopped' })
    hub.close()
    const count = FakeSocket.all.length
    timers.advance(10 * 60_000)
    expect(FakeSocket.all.length).toBe(count)
    expect(FakeSocket.all.every((s) => s.closed)).toBe(true)
  })
})

describe('the tracker client\'s own timers', () => {
  it('uses the page\'s timers without calling them as methods of anything else, which a browser refuses', async () => {
    const real = globalThis.setTimeout
    const delays: unknown[] = []
    vi.stubGlobal('setTimeout', function (this: unknown, ...args: Parameters<typeof setTimeout>) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
      delays.push(args[1])
      return real(...args)
    })
    try {
      const hub = newHub(PEER_A, FakeSocket as unknown as typeof WebSocket)
      hub.join(HASH, { onAnnounce: (send) => send({ event: 'started', left: 0, numwant: 0, offers: [] }), onOffer () {}, onAnswer () {} })
      hub.start()
      await Promise.resolve()
      expect(delays).toContain(DEFAULT_INTERVAL_S * 1000)
      hub.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('sharing between two pages over WebRTC, introduced by a tracker', () => {
  async function kept (content = 'hello') {
    const keep = createKeep(memoryBackend())
    const files = [{ path: 'a.txt', content: text.encode(content) }, { path: 'big.bin', content: Uint8Array.from({ length: 700_000 }, (_, i) => (i * 13) & 255) }]
    const imported = await importTree(files, () => {})
    await keep.add(imported.cid, { kind: 'files', encrypted: false, bytes: 700_000 + content.length, files: 2, online: true }, async (sink) => { await importTree(files, sink) })
    return { keep, root: imported.cid, files }
  }

  function world () {
    const tracker = fakeTracker()
    const rtc = fakeRtc()
    const hub = (peerId: string) => newHub(peerId, tracker.WebSocket)
    return { tracker, rtc, hub }
  }

  /** A seeder of `root` from `keep`, in its own page. */
  async function seed (w: ReturnType<typeof world>, keep: ReturnType<typeof createKeep>, root: string, peerId: string, answer?: (cid: string) => Promise<Uint8Array | null>) {
    const hub = w.hub(peerId)
    const total = { links: 0 }
    const seeder = createSeeder({ keep, root, total, onChange: () => {} })
    const swarm = joinSwarm({
      hub, infoHash: await infoHashOf(root), role: 'seed', canAccept: seeder.canAccept,
      linkHandlers: answer === undefined ? seeder.linkHandlers : { ...seeder.linkHandlers, onRequest: answer },
      onLink: seeder.attach, rtc: { RTCPeerConnectionImpl: w.rtc.RTCPeerConnectionImpl }
    })
    hub.start()
    return { hub, seeder, swarm }
  }

  async function leech (w: ReturnType<typeof world>, root: string, peerId: string) {
    const hub = w.hub(peerId)
    const pool = createPool()
    const swarm = joinSwarm({ hub, infoHash: await infoHashOf(root), role: 'leech', onLink: (link) => pool.add(link), rtc: { RTCPeerConnectionImpl: w.rtc.RTCPeerConnectionImpl } })
    hub.start()
    return { hub, pool, swarm }
  }

  it('lets a page that has only the link read a whole share from the page that kept it, every block checked', async () => {
    const { keep, root, files } = await kept()
    const w = world()
    const seeder = await seed(w, keep, root, PEER_A)
    const reader = await leech(w, root, PEER_B)
    expect(await reader.pool.hasPeer(3000)).toBe(true)
    const source = { block: (cid: string) => reader.pool.block(cid) }
    const big = (await keep.block(root, root))!
    expect(await reader.pool.block(root)).toEqual(big)
    const listing = await listTree(source, root)
    expect(listing.map((f) => f.path)).toEqual(['a.txt', 'big.bin'])
    const blob = await readFileBlob(source, listing[1]!.cid)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(files[1]!.content)
    expect(seeder.seeder.stats.uploaded).toBeGreaterThan(700_000)
    expect(reader.pool.stats.bytes).toBeGreaterThan(700_000)
    expect(JSON.stringify(w.tracker.log), 'a tracker is told a hash, not the address').not.toContain(root)
    expect(w.tracker.log.every((m) => m.info_hash === toBinary(fromBinary(m.info_hash)))).toBe(true)
  }, 20_000)

  it('is refused a block that is not in the share, and the seeder answers none', async () => {
    const { keep, root } = await kept()
    const w = world()
    await seed(w, keep, root, PEER_A)
    const reader = await leech(w, root, PEER_B)
    await reader.pool.hasPeer(3000)
    const stranger = (await cidFor(0x55, text.encode('not in the share'))).string
    await expect(reader.pool.block(stranger)).rejects.toThrow('No connected peer has this block')
  }, 20_000)

  it('reads from the honest peer when another one lies, and lets the liar go', async () => {
    const { keep, root } = await kept()
    const w = world()
    const honest = await seed(w, keep, root, PEER_A)
    const liar = await seed(w, keep, root, toBinary(Uint8Array.from({ length: 20 }, (_, i) => 0x40 + i)), async () => text.encode('a different block'))
    const reader = await leech(w, root, PEER_B)
    await waitFor(() => honest.seeder.peers > 0 && liar.seeder.peers > 0)
    const wanted = (await keep.block(root, root))!
    expect(await reader.pool.block(root)).toEqual(wanted)
    expect(reader.pool.size).toBeGreaterThan(0)
  }, 20_000)

  it('counts a page once, however many offers it makes and however many trackers carry them', async () => {
    const { keep, root } = await kept()
    const w = world()
    const seeder = await seed(w, keep, root, PEER_A)
    const reader = await leech(w, root, PEER_B)
    expect(await reader.pool.hasPeer(3000)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(seeder.seeder.peers).toBe(1)
    expect(reader.pool.size).toBe(1)
    expect(w.tracker.log.filter((m) => m.answer !== undefined), 'one offer was answered, the rest were not').toHaveLength(1)
  }, 20_000)

  it('takes a page for each page: four readers are four peers', async () => {
    const { keep, root } = await kept()
    const w = world()
    const seeder = await seed(w, keep, root, PEER_A)
    const readers = await Promise.all(Array.from({ length: 4 }, (_, i) => leech(w, root, toBinary(Uint8Array.from({ length: 20 }, (_, k) => i * 20 + k)))))
    await waitFor(() => seeder.seeder.peers >= 4)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(seeder.seeder.peers).toBe(4)
    expect(readers.map((r) => r.pool.size)).toEqual([1, 1, 1, 1])
  }, 20_000)

  it('stops answering when it leaves the swarm', async () => {
    const { keep, root } = await kept()
    const w = world()
    const seeder = await seed(w, keep, root, PEER_A)
    await Promise.resolve()
    seeder.swarm.leave()
    seeder.seeder.closeAll()
    expect(w.tracker.log.some((m) => m.event === 'stopped')).toBe(true)
    const reader = await leech(w, root, PEER_B)
    expect(await reader.pool.hasPeer(100)).toBe(false)
  })
})

describe('what a page is serving', () => {
  async function share () {
    const keep = createKeep(memoryBackend())
    const files = [{ path: 'a.txt', content: text.encode('hello') }]
    const imported = await importTree(files, () => {})
    await keep.add(imported.cid, { kind: 'files', encrypted: false, bytes: 5, files: 1, online: true }, async (sink) => { await importTree(files, sink) })
    return { keep, root: imported.cid }
  }

  it('resumes every share kept online when the page opens, and none that were stopped', async () => {
    const { keep, root } = await share()
    const other = await importTree([{ path: 'b', content: text.encode('other') }], () => {})
    await keep.add(other.cid, { kind: 'files', encrypted: false, bytes: 5, files: 1, online: false }, async (sink) => { await importTree([{ path: 'b', content: text.encode('other') }], sink) })
    const w = fakeTracker()
    const hub = newHub(PEER_A, w.WebSocket)
    const serving = createServing({ keep, hub, supported: true, rtc: { RTCPeerConnectionImpl: fakeRtc().RTCPeerConnectionImpl } })
    await serving.start()
    await Promise.resolve()
    const hash = await infoHashOf(root)
    expect(w.log.filter((m) => m.event === 'started').every((m) => m.info_hash === hash && m.left === 0)).toBe(true)
    expect(w.log.some((m) => m.info_hash === hash)).toBe(true)
    const otherHash = await infoHashOf(other.cid)
    expect(w.log.some((m) => m.info_hash === otherHash)).toBe(false)
    expect(serving.state()).toMatchObject({ supported: true, trackers: { connected: 4, total: 4 } })
    expect(serving.state().shares).toEqual(expect.arrayContaining([
      { cid: root, online: true, peers: 0, uploaded: 0, node: 'off' },
      { cid: other.cid, online: false, peers: 0, uploaded: 0, node: 'off' }
    ]))
    await serving.close()
  })

  it('stops and resumes a share, tells whoever listens, and remembers it', async () => {
    const { keep, root } = await share()
    const w = fakeTracker()
    const serving = createServing({ keep, hub: newHub(PEER_A, w.WebSocket), supported: true, rtc: { RTCPeerConnectionImpl: fakeRtc().RTCPeerConnectionImpl } })
    const heard: boolean[] = []
    const unsubscribe = serving.subscribe((state) => { heard.push(state.shares.find((s) => s.cid === root)?.online ?? false) })
    await serving.start()
    await serving.setOnline(root, false)
    expect((await keep.meta(root))!.online).toBe(false)
    expect(w.log.some((m) => m.event === 'stopped')).toBe(true)
    expect(serving.state().shares[0]).toMatchObject({ cid: root, online: false })
    await serving.setOnline(root, true)
    expect((await keep.meta(root))!.online).toBe(true)
    expect(heard.at(-1)).toBe(true)
    unsubscribe()
    const count = heard.length
    await serving.setOnline(root, false)
    expect(heard.length).toBe(count)
    await serving.removed(root)
    expect(serving.state().shares).toEqual([])
    await serving.close()
  })

  it('hands a share to the page\'s IPFS node and reports what the node says', async () => {
    const { keep, root } = await share()
    const calls: string[] = []
    const node = {
      provide: async (cid: string) => { calls.push(`provide ${cid}`) },
      unprovide: async (cid: string) => { calls.push(`unprovide ${cid}`) },
      poll: async () => true,
      stateOf: (cid: string) => (cid === root ? 'announced' : 'off') as 'announced' | 'off'
    }
    const w = fakeTracker()
    const serving = createServing({ keep, hub: newHub(PEER_A, w.WebSocket), node, supported: true, rtc: { RTCPeerConnectionImpl: fakeRtc().RTCPeerConnectionImpl } })
    await serving.start()
    expect(calls).toEqual([`provide ${root}`])
    expect(serving.state().shares[0]!.node).toBe('announced')
    await serving.setOnline(root, false)
    expect(calls).toContain(`unprovide ${root}`)
    await serving.close()
  })

  it('serves nothing where the page has no WebSocket or WebRTC, and says so', async () => {
    const { keep } = await share()
    const w = fakeTracker()
    const serving = createServing({ keep, hub: newHub(PEER_A, w.WebSocket), supported: false })
    await serving.start()
    expect(w.log).toEqual([])
    expect(serving.state().supported).toBe(false)
    await serving.close()
  })
})

describe('reading a share from its peers and the gateways', () => {
  const gateways = ['https://gw.example']
  afterEach(() => { for (const root of roots.splice(0)) closeSession(root) })
  const roots: string[] = []

  async function built () {
    const files = [{ path: 'a.txt', content: text.encode('hello') }, { path: 'big.bin', content: Uint8Array.from({ length: 600_000 }, (_, i) => (i * 3) & 255) }]
    const blocks = new Map<string, Uint8Array>()
    const imported = await importTree(files, (cid, bytes) => { blocks.set(cid, bytes.slice()) })
    roots.push(imported.cid)
    return { files, blocks, root: imported.cid }
  }

  it('reads from the keeping computer without asking anyone', async () => {
    const { files, root } = await built()
    const keep = createKeep(memoryBackend())
    await keep.add(root, { kind: 'files', encrypted: false, bytes: 600_005, files: 2, online: true }, async (sink) => { await importTree(files, sink) })
    const asked: string[] = []
    const session = await sessionFor(root, { keep, hub: null, gateways, fetchImpl: (async (url: string) => { asked.push(url); throw new Error('offline') }) as unknown as typeof fetch })
    const rootBlock = await session.block(root)
    expect(rootBlock.length).toBeGreaterThan(10)
    const big = await listTree({ block: (c: string) => session.block(c) }, root)
    const progress: string[] = []
    const { blob, source } = await session.file(big[1]!.cid, { total: 600_000, onProgress: (p) => progress.push(p.source) })
    expect(source).toBe('local')
    expect(blob.size).toBe(600_000)
    expect(asked).toEqual([])
    expect(progress).toEqual(['local'])
    session.close()
  })

  it('goes to a gateway when no peer is there, and says so', async () => {
    const { blocks, root } = await built()
    const { writeCar } = await import('../page/src/ipfs/car.js')
    const fetchImpl = (async (url: string) => {
      const cid = new URL(url).pathname.split('/')[2]!
      return new Response(writeCar(cid, new Map([[cid, blocks.get(cid)!]])))
    }) as unknown as typeof fetch
    const session = await sessionFor(root, { keep: null, hub: null, gateways, fetchImpl })
    expect(session.peers).toBe(0)
    expect((await session.block(root)).length).toBeGreaterThan(10)
    session.close()
  })

  it('prefers a peer, and starts the gateways only if it is slow', async () => {
    const { files, blocks, root } = await built()
    const keep = createKeep(memoryBackend())
    await keep.add(root, { kind: 'files', encrypted: false, bytes: 600_005, files: 2, online: true }, async (sink) => { await importTree(files, sink) })
    const tracker = fakeTracker()
    const rtc = fakeRtc()
    const seedHub = newHub(PEER_A, tracker.WebSocket)
    const seeder = createSeeder({ keep, root, total: { links: 0 }, onChange: () => {} })
    joinSwarm({ hub: seedHub, infoHash: await infoHashOf(root), role: 'seed', canAccept: seeder.canAccept, linkHandlers: seeder.linkHandlers, onLink: seeder.attach, rtc: { RTCPeerConnectionImpl: rtc.RTCPeerConnectionImpl } })
    seedHub.start()
    const asked: string[] = []
    const fetchImpl = (async (url: string) => { asked.push(url); throw new Error('gateway down') }) as unknown as typeof fetch
    const hub = newHub(PEER_B, tracker.WebSocket)
    const session = await sessionFor(root, { keep: null, hub, rtc: { RTCPeerConnectionImpl: rtc.RTCPeerConnectionImpl }, gateways, fetchImpl, headStartMs: 400 })
    expect(await session.pool.hasPeer(3000)).toBe(true)
    const listing = await listTree({ block: (c: string) => session.block(c) }, root)
    const progress: { source: string, done: number }[] = []
    const { blob, source } = await session.file(listing[1]!.cid, { total: 600_000, onProgress: (p) => progress.push(p) })
    expect(source).toBe('peer')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(files[1]!.content)
    expect(progress.every((p) => p.source === 'peer')).toBe(true)
    expect(progress.at(-1)!.done).toBe(600_000)
    expect(asked, 'no gateway was asked').toEqual([])
    void blocks
    session.close()
  }, 20_000)

  it('waits for a peer that connects after the read began, so a share held only on its sender\'s computer opens', async () => {
    const { files, root } = await built()
    const keep = createKeep(memoryBackend())
    await keep.add(root, { kind: 'files', encrypted: false, bytes: 600_005, files: 2, online: true }, async (sink) => { await importTree(files, sink) })
    const tracker = fakeTracker()
    const rtc = fakeRtc()
    const seedHub = newHub(PEER_A, tracker.WebSocket)
    const seeder = createSeeder({ keep, root, total: { links: 0 }, onChange: () => {} })
    joinSwarm({ hub: seedHub, infoHash: await infoHashOf(root), role: 'seed', canAccept: seeder.canAccept, linkHandlers: seeder.linkHandlers, onLink: seeder.attach, rtc: { RTCPeerConnectionImpl: rtc.RTCPeerConnectionImpl } })
    seedHub.start()
    const asked: string[] = []
    const fetchImpl = (async (url: string) => { asked.push(url); return new Response('not found', { status: 404 }) }) as unknown as typeof fetch
    const session = await sessionFor(root, { keep: null, hub: newHub(PEER_B, tracker.WebSocket), rtc: { RTCPeerConnectionImpl: rtc.RTCPeerConnectionImpl }, gateways, fetchImpl })
    expect(session.peers, 'nobody has connected yet').toBe(0)
    const sources: string[] = []
    const rootBlock = await session.block(root, { onSource: (source) => sources.push(source) })
    expect(rootBlock).toEqual((await keep.block(root, root))!)
    expect(sources).toEqual(['peer'])
    const listing = await listTree({ block: (c: string) => session.block(c) }, root)
    const { blob, source } = await session.file(listing[1]!.cid, { total: 600_000 })
    expect(source).toBe('peer')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(files[1]!.content)
    expect(asked.length, 'the gateways were tried and had nothing').toBeGreaterThan(0)
    session.close()
  }, 20_000)

  it('asks the trackers again while it waits, so a sender that opened Share after the link did is found', async () => {
    const { files, root } = await built()
    const keep = createKeep(memoryBackend())
    await keep.add(root, { kind: 'files', encrypted: false, bytes: 600_005, files: 2, online: true }, async (sink) => { await importTree(files, sink) })
    const tracker = fakeTracker()
    const rtc = fakeRtc()
    const fetchImpl = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch
    const session = await sessionFor(root, { keep: null, hub: newHub(PEER_B, tracker.WebSocket), rtc: { RTCPeerConnectionImpl: rtc.RTCPeerConnectionImpl }, gateways, fetchImpl, peerWaitMs: 3000, peerRefreshMs: 100 })
    const reading = session.block(root)
    await new Promise((resolve) => setTimeout(resolve, 250))
    const seedHub = newHub(PEER_A, tracker.WebSocket)
    const seeder = createSeeder({ keep, root, total: { links: 0 }, onChange: () => {} })
    joinSwarm({ hub: seedHub, infoHash: await infoHashOf(root), role: 'seed', canAccept: seeder.canAccept, linkHandlers: seeder.linkHandlers, onLink: seeder.attach, rtc: { RTCPeerConnectionImpl: rtc.RTCPeerConnectionImpl } })
    seedHub.start()
    expect(await reading).toEqual((await keep.block(root, root))!)
    session.close()
  }, 20_000)

  it('says what it tried when no gateway has the share and no computer that has it is found', async () => {
    const { root } = await built()
    const tracker = fakeTracker()
    const rtc = fakeRtc()
    const fetchImpl = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch
    const session = await sessionFor(root, { keep: null, hub: newHub(PEER_B, tracker.WebSocket), rtc: { RTCPeerConnectionImpl: rtc.RTCPeerConnectionImpl }, gateways, fetchImpl, peerWaitMs: 60 })
    await expect(session.block(root)).rejects.toThrow(/gw\.example: it does not have this.*no computer that has it/s)
    session.close()
  })

  it('falls back to a gateway when the peer cannot give the file', async () => {
    const { files, blocks, root } = await built()
    const { writeCar } = await import('../page/src/ipfs/car.js')
    const listing = await listTree({ block: async (c: string) => blocks.get(c)! }, root)
    const bigCid = listing[1]!.cid
    const tracker = fakeTracker()
    const rtc = fakeRtc()
    const seedHub = newHub(PEER_A, tracker.WebSocket)
    const empty = createKeep(memoryBackend())
    const seeder = createSeeder({ keep: empty, root, total: { links: 0 }, onChange: () => {} })
    joinSwarm({ hub: seedHub, infoHash: await infoHashOf(root), role: 'seed', canAccept: seeder.canAccept, linkHandlers: seeder.linkHandlers, onLink: seeder.attach, rtc: { RTCPeerConnectionImpl: rtc.RTCPeerConnectionImpl } })
    seedHub.start()
    const fileBlocks = new Map<string, Uint8Array>()
    const collectFile = async (cid: string) => {
      fileBlocks.set(cid, blocks.get(cid)!)
      const { decodeNode } = await import('../page/src/ipfs/dagpb.js')
      const { readCidBytes } = await import('../page/src/ipfs/cid.js')
      if (parseCid(cid).codec === 0x70) for (const link of decodeNode(blocks.get(cid)!).links) await collectFile(readCidBytes(link.hash).cid.string)
    }
    await collectFile(bigCid)
    const fetchImpl = (async () => new Response(writeCar(bigCid, fileBlocks))) as unknown as typeof fetch
    const hub = newHub(PEER_B, tracker.WebSocket)
    const session = await sessionFor(root, { keep: null, hub, rtc: { RTCPeerConnectionImpl: rtc.RTCPeerConnectionImpl }, gateways, fetchImpl, headStartMs: 20 })
    expect(await session.pool.hasPeer(3000)).toBe(true)
    const { blob, source } = await session.file(bigCid, { total: 600_000 })
    expect(source).toBe('gateway')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(files[1]!.content)
    session.close()
  }, 20_000)
})

// The Worker's calls to the node's API share the few connections its engine lets one page hold to one host and port (six). A read that waits on the network for
// someone else's content holds one for as long as it waits, up to twenty seconds, so a burst of them kept a community's key import, which its first record waits
// for, out of the connections until they gave up. These tests say how the lanes keep room for the calls that matter.
import { describe, expect, it } from 'vitest'
import { createLanes } from '../kubo/lanes.js'
import { createNodeClient } from '../kubo/node-client.js'

/** Lets what is waiting on a settled promise run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A promise that settles when told, so a call can be held open and let go. */
function gate<T = void> () {
  let open!: (value: T) => void
  let fail!: (reason: unknown) => void
  const promise = new Promise<T>((resolve, reject) => { open = resolve; fail = reject })
  return { promise, open, fail }
}

describe('createLanes', () => {
  it('runs up to four slow calls at once and the others as they finish, in the order they came', async () => {
    const lanes = createLanes()
    const started: number[] = []
    const gates = Array.from({ length: 7 }, () => gate<string>())
    const done = gates.map((one, index) => lanes.slow(() => { started.push(index); return one.promise }))
    await tick()
    expect(started).toEqual([0, 1, 2, 3])
    expect(lanes.snapshot()).toMatchObject({ slowRunning: 4, slowQueued: 3, cap: 4 })
    gates[2]!.open('c')
    expect(await done[2]).toBe('c')
    await tick()
    expect(started).toEqual([0, 1, 2, 3, 4])
    gates[0]!.open('a')
    gates[1]!.open('b')
    await done[0]
    await done[1]
    await tick()
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6])
    for (const one of gates) one.open('x')
    await Promise.all(done)
    expect(lanes.snapshot()).toMatchObject({ slowRunning: 0, slowQueued: 0 })
  })

  it('gives a place back when a slow call fails, and passes the failure on', async () => {
    const lanes = createLanes({ slowMax: 1 })
    const first = gate<string>()
    const a = lanes.slow(() => first.promise)
    const b = lanes.slow(async () => 'second')
    first.fail(new Error('refused'))
    await expect(a).rejects.toThrow('refused')
    expect(await b).toBe('second')
  })

  it('leaves fewer places to slow calls for each stream held open, and never fewer than one', async () => {
    const lanes = createLanes()
    expect(lanes.snapshot().cap).toBe(4)
    const releases = [lanes.hold(), lanes.hold()]
    expect(lanes.snapshot().cap).toBe(2)
    releases.push(lanes.hold(), lanes.hold(), lanes.hold())
    expect(lanes.snapshot().cap).toBe(1)
    releases[0]!()
    releases[0]!()
    expect(lanes.snapshot()).toMatchObject({ held: 4, cap: 1 })
    for (const release of releases) release()
    expect(lanes.snapshot()).toMatchObject({ held: 0, cap: 4 })
  })

  it('starts a queued call when a stream is let go and the room it frees is the call\'s', async () => {
    const lanes = createLanes()
    const releases = [lanes.hold(), lanes.hold(), lanes.hold()]
    const running = gate<string>()
    const first = lanes.slow(() => running.promise)
    let secondStarted = false
    const second = lanes.slow(async () => { secondStarted = true; return 'second' })
    await tick()
    expect(secondStarted).toBe(false)
    releases[0]!()
    expect(await second).toBe('second')
    running.open('first')
    await first
  })

  it('drops a call that is aborted while it waits, without ever starting it', async () => {
    const lanes = createLanes({ slowMax: 1 })
    const blocker = gate<string>()
    const running = lanes.slow(() => blocker.promise)
    const controller = new AbortController()
    let started = false
    const waiting = lanes.slow(async () => { started = true; return 'never' }, controller.signal)
    controller.abort(new DOMException('gone', 'AbortError'))
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(lanes.snapshot().slowQueued).toBe(0)
    blocker.open('done')
    await running
    expect(started).toBe(false)
  })

  it('refuses at once a call whose signal is already aborted', async () => {
    const lanes = createLanes()
    const controller = new AbortController()
    controller.abort()
    await expect(lanes.slow(async () => 'x', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('has no limit when told so', async () => {
    const lanes = createLanes({ slowMax: 0 })
    const gates = Array.from({ length: 20 }, () => gate<string>())
    let running = 0
    const done = gates.map((one) => lanes.slow(() => { running += 1; return one.promise }))
    await tick()
    expect(running).toBe(20)
    for (const one of gates) one.open('x')
    await Promise.all(done)
  })
})

describe('the node client with lanes', () => {
  /** A fetch that holds every call whose path starts with a name in `hold` until `release` is called for it, and answers the others at once. */
  function holding (hold: string[]) {
    const gates = new Map<string, Array<ReturnType<typeof gate<void>>>>()
    const seen: string[] = []
    let open = 0
    let peak = 0
    const fetch = async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      seen.push(path)
      const name = hold.find((one) => path.startsWith(one))
      if (name !== undefined) {
        const one = gate()
        gates.set(name, [...(gates.get(name) ?? []), one])
        open += 1
        peak = Math.max(peak, open)
        try { await Promise.race([one.promise, new Promise((_, reject) => { init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason) }) })]) } finally { open -= 1 }
      }
      return new Response(JSON.stringify({ cid: 'bafy', label: 'k', name: 'n' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return { fetch: fetch as unknown as typeof globalThis.fetch, seen, peak: () => peak, release: (name: string) => { for (const one of gates.get(name) ?? []) one.open() } }
  }

  it('sends a key import at once while ten reads that wait on the network are held, and never has more than four of them out', async () => {
    const fake = holding(['/orivon/cat/'])
    const node = createNodeClient({ base: 'http://127.0.0.1:1', key: 'k', fetch: fake.fetch })
    const reads = Array.from({ length: 10 }, (_, index) => node.cat(`bafy${String(index)}`))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(fake.seen.filter((path) => path.startsWith('/orivon/cat/'))).toHaveLength(4)
    const imported = await node.importKey('community', new Uint8Array([1, 2, 3]))
    expect(imported).toMatchObject({ label: 'k' })
    expect(fake.seen).toContain('/orivon/ipns/keys/import')
    fake.release('/orivon/cat/')
    await new Promise((resolve) => setTimeout(resolve, 5))
    fake.release('/orivon/cat/')
    await new Promise((resolve) => setTimeout(resolve, 5))
    fake.release('/orivon/cat/')
    await Promise.all(reads)
    expect(fake.peak()).toBeLessThanOrEqual(4)
    expect(fake.seen.filter((path) => path.startsWith('/orivon/cat/'))).toHaveLength(10)
  })

  it('puts block reads, name resolves, resolves and listings in the same lane, and a publish, a provide and a pin outside it', async () => {
    const fake = holding(['/ipfs/', '/orivon/name/resolve/', '/orivon/resolve/', '/orivon/ls/'])
    const node = createNodeClient({ base: 'http://127.0.0.1:1', key: 'k', fetch: fake.fetch })
    const slow = [
      node.getBlock('bafy1'), node.getBlock('bafy2'), node.resolveName('k51a').catch(() => ''), node.resolveName('k51b').catch(() => ''),
      node.resolve('bafy3').catch(() => ''), node.ls('bafy4').catch(() => []), node.getBlock('bafy5')
    ]
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(fake.seen).toHaveLength(4)
    await node.publishName({ label: 'k', value: '/ipfs/bafy' }).catch(() => null)
    await node.provide('bafy', false).catch(() => null)
    await node.pin('bafy').catch(() => null)
    expect(fake.seen).toContain('/orivon/ipns/publish')
    expect(fake.seen).toContain('/orivon/provide/bafy')
    expect(fake.seen).toContain('/orivon/pin/bafy')
    for (let round = 0; round < 4; round += 1) {
      for (const name of ['/ipfs/', '/orivon/name/resolve/', '/orivon/resolve/', '/orivon/ls/']) fake.release(name)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await Promise.all(slow)
    expect(fake.peak()).toBeLessThanOrEqual(4)
  })

  it('counts a pubsub subscription as held for as long as its stream is open, and lets it go when the stream ends or is cancelled', async () => {
    const lanes = createLanes()
    const stream = () => new ReadableStream<Uint8Array>({ start (controller) { controller.enqueue(new Uint8Array([1])) } })
    const bodies: ReadableStream<Uint8Array>[] = []
    const fetch = (async () => { const body = stream(); bodies.push(body); return new Response(body, { status: 200 }) }) as unknown as typeof globalThis.fetch
    const node = createNodeClient({ base: 'http://127.0.0.1:1', key: 'k', fetch, lanes })
    const first = await node.pubsubSubscribe('topic-a')
    const second = await node.pubsubSubscribe('topic-b')
    expect(lanes.snapshot()).toMatchObject({ held: 2, cap: 2 })
    await first.body!.cancel()
    expect(lanes.snapshot().held).toBe(1)
    const reader = second.body!.getReader()
    await reader.read()
    await reader.cancel()
    expect(lanes.snapshot().held).toBe(0)
  })

  it('counts a subscription that ends by itself, and one the node refuses, as let go', async () => {
    const lanes = createLanes()
    const ending = (async () => new Response(new ReadableStream({ start (controller) { controller.enqueue(new Uint8Array([1])); controller.close() } }), { status: 200 })) as unknown as typeof globalThis.fetch
    const node = createNodeClient({ base: 'http://127.0.0.1:1', key: 'k', fetch: ending, lanes })
    const stream = await node.pubsubSubscribe('t')
    expect(lanes.snapshot().held).toBe(1)
    const reader = stream.body!.getReader()
    while (!(await reader.read()).done) { /* to the end */ }
    expect(lanes.snapshot().held).toBe(0)
    const refusing = (async () => new Response('no', { status: 503 })) as unknown as typeof globalThis.fetch
    const refused = createNodeClient({ base: 'http://127.0.0.1:1', key: 'k', fetch: refusing, lanes })
    await expect(refused.pubsubSubscribe('t')).rejects.toMatchObject({ status: 503 })
    expect(lanes.snapshot().held).toBe(0)
  })
})

describe('the node client and the names the node holds', () => {
  const answers = (extra: Record<string, () => Response> = {}) => {
    const seen: string[] = []
    const held: Array<ReturnType<typeof gate<void>>> = []
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      seen.push(path)
      const answer = extra[`${init?.method ?? 'GET'} ${path}`]
      if (answer !== undefined) return answer()
      if (path.startsWith('/orivon/cat/')) { const one = gate(); held.push(one); await one.promise }
      return new Response(JSON.stringify({ label: 'community', name: '12D3KooWOwn' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof globalThis.fetch
    return { fetch, seen, held }
  }

  it('reads a name whose key the node holds at once while reads that wait on the network hold every place, and a name it does not hold after them', async () => {
    const fake = answers()
    const node = createNodeClient({ base: 'http://127.0.0.1:1', key: 'k', fetch: fake.fetch })
    const reads = Array.from({ length: 6 }, (_, index) => node.cat(`bafy${String(index)}`))
    await tick()
    expect(fake.held).toHaveLength(4)
    const others = node.gateway('/ipns/12D3KooWElse', {}).catch(() => null)
    await tick()
    expect(fake.seen).not.toContain('/ipns/12D3KooWElse')
    await node.importKey('community', new Uint8Array([1]))
    const record = await node.gateway('/ipns/12D3KooWOwn?format=ipns-record', {})
    expect(record.status).toBe(200)
    expect(await node.resolveName('12D3KooWOwn')).toBeUndefined()
    expect(fake.seen).toContain('/ipns/12D3KooWOwn')
    expect(fake.seen).toContain('/orivon/name/resolve/12D3KooWOwn')
    expect(fake.seen).not.toContain('/ipns/12D3KooWElse')
    for (const one of fake.held) one.open()
    await tick()
    for (const one of fake.held) one.open()
    await Promise.all([...reads, others])
    expect(fake.seen).toContain('/ipns/12D3KooWElse')
  })

  it('keeps a path below a name, and a name given in another spelling, in the lane of reads that wait on the network', async () => {
    const fake = answers()
    const node = createNodeClient({ base: 'http://127.0.0.1:1', key: 'k', fetch: fake.fetch })
    await node.importKey('community', new Uint8Array([1]))
    const reads = Array.from({ length: 4 }, (_, index) => node.cat(`bafy${String(index)}`))
    await tick()
    const below = node.gateway('/ipns/12D3KooWOwn/posts/1', {}).catch(() => null)
    const spelt = node.gateway('/ipns/k51qzi5uqu5own', {}).catch(() => null)
    await tick()
    expect(fake.seen).not.toContain('/ipns/12D3KooWOwn/posts/1')
    expect(fake.seen).not.toContain('/ipns/k51qzi5uqu5own')
    for (let round = 0; round < 3; round += 1) { for (const one of fake.held) one.open(); await tick() }
    await Promise.all([...reads, below, spelt])
  })

  it('learns the names of the keys it holds from a key generated, from a list, and from an import the node refuses as already held', async () => {
    const fake = answers({
      'GET /orivon/ipns/keys': () => new Response(JSON.stringify([{ label: 'one', name: '12D3KooWListed' }]), { status: 200, headers: { 'content-type': 'application/json' } }),
      'POST /orivon/ipns/keys/import': () => new Response('the node already holds this key', { status: 409 })
    })
    const node = createNodeClient({ base: 'http://127.0.0.1:1', key: 'k', fetch: fake.fetch })
    const reads = Array.from({ length: 4 }, (_, index) => node.cat(`bafy${String(index)}`))
    await tick()
    await expect(node.importKey('one', new Uint8Array([1]))).rejects.toMatchObject({ status: 409 })
    await node.gateway('/ipns/12D3KooWListed', {})
    expect(fake.seen).toContain('/ipns/12D3KooWListed')
    await node.generateKey('fresh')
    await node.gateway('/ipns/12D3KooWOwn', {})
    expect(fake.seen).toContain('/ipns/12D3KooWOwn')
    for (let round = 0; round < 2; round += 1) { for (const one of fake.held) one.open(); await tick() }
    await Promise.all(reads)
  })
})

describe('the node client\'s call trace', () => {
  it('writes, for each call, when it is sent (with its lane, what it waited in the lane, how many calls are out and how many streams are held) and when it is answered', async () => {
    const lines: string[] = []
    let clock = 1000
    const gates: Array<ReturnType<typeof gate<void>>> = []
    const fetch = (async (_input: string | URL) => { const one = gate(); gates.push(one); await one.promise; return new Response('{}', { status: 200 }) }) as unknown as typeof globalThis.fetch
    const node = createNodeClient({ base: 'http://127.0.0.1:1', key: 'k', fetch, lanes: createLanes({ slowMax: 1 }), trace: (line) => lines.push(line), now: () => clock })
    const imported = node.importKey('community', new Uint8Array([1]))
    const first = node.cat('bafy1')
    const second = node.cat('bafy2')
    await tick()
    expect(gates).toHaveLength(2)
    clock = 1400
    gates[1]!.open()
    await first
    await tick()
    expect(gates).toHaveLength(3)
    clock = 1500
    gates[0]!.open()
    gates[2]!.open()
    await Promise.all([imported, second])
    expect(lines).toEqual([
      'node call t=1000 POST /orivon/ipns/keys/import lane=control waited=0 out=1 held=0',
      'node call t=1000 GET /orivon/cat/bafy1 lane=slow waited=0 out=2 held=0',
      'node done t=1400 GET /orivon/cat/bafy1 200 in 400 ms',
      'node call t=1400 GET /orivon/cat/bafy2 lane=slow waited=400 out=2 held=0',
      'node done t=1500 POST /orivon/ipns/keys/import 200 in 500 ms',
      'node done t=1500 GET /orivon/cat/bafy2 200 in 100 ms'
    ])
  })

  it('writes nothing when no trace is given', async () => {
    const fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch
    const node = createNodeClient({ base: 'http://127.0.0.1:1', key: 'k', fetch })
    await node.importKey('community', new Uint8Array([1]))
  })
})

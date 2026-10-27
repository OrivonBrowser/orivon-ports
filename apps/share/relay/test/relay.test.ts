import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { tcp } from '@libp2p/tcp'
import { echo, lpStream } from '@libp2p/utils'
import { multiaddr } from '@multiformats/multiaddr'
import { createLibp2p } from 'libp2p'
import type { Libp2p, PeerId } from '@libp2p/interface'
import { loadOrCreateKey } from '../key.mjs'
import { createRelayNode, hostOf } from '../node.mjs'

const HOP = '/libp2p/circuit/relay/0.2.0/hop'
const ECHO = '/orivon-share-relay-test/echo/1.0.0'
const MIB = 1024 * 1024

// Circuit relay v2 hop messages, read and written as bytes. The test does not use the library's
// own codec, so what it checks is what any other implementation's client would receive.
const TYPE_RESERVE = 0
const TYPE_CONNECT = 1
const FIELD = { type: 1, peer: 2, reservation: 3, limit: 4, status: 5 }
const STATUS = { ok: 100n, reservationRefused: 200n, permissionDenied: 202n }

type Fields = Map<number, Array<bigint | Uint8Array>>

function varint (value: number): number[] {
  const out: number[] = []
  let rest = value
  while (rest > 0x7f) { out.push((rest & 0x7f) | 0x80); rest >>>= 7 }
  out.push(rest)
  return out
}

function parse (bytes: Uint8Array): Fields {
  const fields: Fields = new Map()
  let at = 0
  const read = (): bigint => {
    let value = 0n
    for (let shift = 0n; ; shift += 7n) {
      const byte = bytes[at++]!
      value |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return value
    }
  }
  while (at < bytes.length) {
    const tag = read()
    const field = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    let value: bigint | Uint8Array
    if (wire === 0) value = read()
    else if (wire === 2) { const length = Number(read()); value = bytes.subarray(at, at + length); at += length } else throw new Error(`unexpected wire type ${String(wire)}`)
    fields.set(field, [...fields.get(field) ?? [], value])
  }
  return fields
}

const reserveRequest = (): Uint8Array => Uint8Array.from([0x08, TYPE_RESERVE])

function connectRequest (target: PeerId): Uint8Array {
  const id = target.toMultihash().bytes
  const peer = [0x0a, ...varint(id.length), ...id]
  return Uint8Array.from([0x08, TYPE_CONNECT, 0x12, ...varint(peer.length), ...peer])
}

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

async function startRelay (overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'share-relay-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const relay = await createRelayNode({ privateKey: await loadOrCreateKey(dir), listen: ['/ip4/127.0.0.1/tcp/0'], overrides })
  cleanups.push(() => relay.stop())
  return { relay, address: relay.addresses()[0]! }
}

async function client (listen: string[] = []): Promise<Libp2p> {
  const node = await createLibp2p({
    addresses: { listen },
    transports: [tcp(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() }
  })
  cleanups.push(() => node.stop())
  return node
}

/** One hop request on a fresh connection to the relay, and the answer decoded to its fields. */
async function hop (from: Libp2p, address: string, request: Uint8Array): Promise<Fields> {
  const connection = await from.dial(multiaddr(address))
  const stream = await connection.newStream(HOP)
  const frames = lpStream(stream)
  await frames.write(request)
  return parse((await frames.read()).subarray())
}

/** A node that holds a reservation on the relay and answers the echo protocol. */
async function reservedPeer (address: string): Promise<Libp2p> {
  const peer = await client([`${address}/p2p-circuit`])
  await peer.handle(ECHO, (stream) => { void echo(stream) })
  await waitFor(() => peer.getMultiaddrs().some((a) => a.toString().includes('/p2p-circuit')))
  return peer
}

async function waitFor (condition: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms
  while (!condition()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('a reservation', () => {
  it('is granted with no limit in the answer', async () => {
    const { address } = await startRelay()
    const answer = await hop(await client(), address, reserveRequest())
    expect(answer.get(FIELD.status)).toEqual([STATUS.ok])
    expect(answer.has(FIELD.reservation)).toBe(true)
    expect(answer.has(FIELD.limit)).toBe(false)
  })

  it('is refused past the cap, and a refused answer carries no reservation', async () => {
    const { address } = await startRelay({ reservations: { applyDefaultLimit: false, maxReservations: 1, reservationTtl: 60_000 } })
    expect((await hop(await client(), address, reserveRequest())).get(FIELD.status)).toEqual([STATUS.ok])
    const second = await hop(await client(), address, reserveRequest())
    expect(second.get(FIELD.status)).toEqual([STATUS.reservationRefused])
    expect(second.has(FIELD.reservation)).toBe(false)
  })

  it('is refused to a host that already holds its share of the table, and still renewed for those holding one', async () => {
    const { address } = await startRelay({ reservations: { applyDefaultLimit: false, maxReservations: 8, reservationTtl: 60_000 }, perHostReservations: 2 })
    const holders = [await client(), await client()]
    for (const holder of holders) expect((await hop(holder, address, reserveRequest())).get(FIELD.status)).toEqual([STATUS.ok])
    const third = await hop(await client(), address, reserveRequest())
    expect(third.get(FIELD.status)).toEqual([STATUS.permissionDenied])
    expect(third.has(FIELD.reservation)).toBe(false)
    expect((await hop(holders[0]!, address, reserveRequest())).get(FIELD.status)).toEqual([STATUS.ok])
  })

  it('is answered with the default limit when the relay is told to apply one: the check above can fail', async () => {
    const { address } = await startRelay({ reservations: { applyDefaultLimit: true, maxReservations: 8, reservationTtl: 60_000 } })
    const answer = await hop(await client(), address, reserveRequest())
    expect(answer.has(FIELD.limit)).toBe(true)
  })
})

describe('a relayed connection', () => {
  it('is answered without a limit when a peer asks to connect to a reserved peer', async () => {
    const { address } = await startRelay()
    const reserved = await reservedPeer(address)
    const answer = await hop(await client(), address, connectRequest(reserved.peerId))
    expect(answer.get(FIELD.status)).toEqual([STATUS.ok])
    expect(answer.has(FIELD.limit)).toBe(false)
  })

  it('carries more than 1 MiB on one stream in each direction, and the relay counts it', async () => {
    const { relay, address } = await startRelay()
    const reserved = await reservedPeer(address)
    const dialer = await client()

    const connection = await dialer.dial(multiaddr(`${address}/p2p-circuit/p2p/${reserved.peerId.toString()}`))
    expect(connection.remoteAddr.toString()).toContain('/p2p-circuit')
    expect(connection.limits).toBeUndefined()
    const stream = await connection.newStream(ECHO)

    const total = 3 * MIB
    const sent = createHash('sha256')
    const received = createHash('sha256')
    let receivedBytes = 0
    const reading = (async () => {
      for await (const chunk of stream) { received.update(chunk.subarray()); receivedBytes += chunk.byteLength }
    })()
    for (let at = 0; at < total; at += 64 * 1024) {
      const chunk = randomBytes(64 * 1024)
      sent.update(chunk)
      if (!stream.send(chunk)) await stream.onDrain()
    }
    await stream.close()
    await reading

    expect(receivedBytes).toBe(total)
    expect(received.digest('hex')).toBe(sent.digest('hex'))
    const there = reserved.getConnections(dialer.peerId)
    expect(there).toHaveLength(1)
    expect(there[0]!.limits).toBeUndefined()

    const stats = relay.stats()
    expect(stats.circuits).toBe(1)
    expect(stats.reservations).toBe(1)
    expect(stats.bytes).toBeGreaterThanOrEqual(2 * total)
  }, 30_000)

  it('is limited, and the same transfer cannot start, when the relay applies the default limit', async () => {
    const { address } = await startRelay({ reservations: { applyDefaultLimit: true, maxReservations: 8, reservationTtl: 60_000 } })
    const reserved = await reservedPeer(address)
    const dialer = await client()
    const connection = await dialer.dial(multiaddr(`${address}/p2p-circuit/p2p/${reserved.peerId.toString()}`))
    expect(connection.limits).toBeDefined()
    await expect(connection.newStream(ECHO)).rejects.toThrow()
  }, 30_000)
})

describe('the relay\'s key', () => {
  it('is made once and read back on every later start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'share-relay-key-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const first = await createRelayNode({ privateKey: await loadOrCreateKey(dir), listen: ['/ip4/127.0.0.1/tcp/0'] })
    const id = first.peerId.toString()
    await first.stop()
    const second = await createRelayNode({ privateKey: await loadOrCreateKey(dir), listen: ['/ip4/127.0.0.1/tcp/0'] })
    cleanups.push(() => second.stop())
    expect(second.peerId.toString()).toBe(id)
    expect(second.addresses()[0]).toContain(`/p2p/${id}`)
  })

  it('is never replaced when the file exists and cannot be read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'share-relay-key-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    await loadOrCreateKey(dir)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'peer-key.pb'), 'not a key')
    await expect(loadOrCreateKey(dir)).rejects.toThrow()
  })
})

describe('the address a reservation is counted under', () => {
  it('is the IPv4 address, or the first 64 bits of an IPv6 one', () => {
    const host = (text: string): string | undefined => hostOf(multiaddr(text))
    expect(host('/ip4/203.0.113.7/tcp/1')).toBe('203.0.113.7')
    expect(host('/ip6/2001:db8:1:2:3:4:5:6/tcp/1')).toBe(host('/ip6/2001:db8:1:2:ffff::9/tcp/2'))
    expect(host('/ip6/2001:db8:1:2:3:4:5:6/tcp/1')).not.toBe(host('/ip6/2001:db8:1:3:3:4:5:6/tcp/1'))
    expect(host('/ip6/2001:db8::1/tcp/1')).toBe(host('/ip6/2001:db8:0:0:5::7/tcp/1'))
    expect(hostOf(undefined)).toBeUndefined()
  })
})

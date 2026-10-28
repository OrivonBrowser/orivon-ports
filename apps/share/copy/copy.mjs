// Orivon Share's copy on Orivon's server: keeps one share, sent as the CAR the Share page makes, for KEEP_DAYS
// on Orivon's own Kubo node and on its Filebase account, once the page asks for it. The page computes the
// share's address itself and accepts the copy only when this answer names the same one. The CAR is read
// block by block (rules.mjs), written to disk as a CAR rebuilt from the checked blocks, and imported from
// there. Share has its own budgets and its own record, apart from DecentraWiki's free pinning. It runs behind
// Caddy on 127.0.0.1, keeps no address of anyone, and counts requests per client in memory only.
// Configuration: FILEBASE_KEY (required), PORT, STATE_DIR, FILEBASE_RPC, KUBO_RPC, CAR_BYTES, LIVE_BYTES, DAY_BYTES.

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCid } from '../page/src/ipfs/cid.js'
import { rpc } from './backend.mjs'
import { LIMITS, Refusal, TOO_LARGE, checkCar } from './rules.mjs'
import { KEEP_DAYS, addPin, blockedFile, endsAt, markDropped, pinsFile, readBlocked, readPins, usage } from './store.mjs'

const PORT = Number(process.env.PORT ?? 8093)
const STATE_DIR = process.env.STATE_DIR ?? '/var/lib/share-copy'
const KEY = process.env.FILEBASE_KEY ?? ''
const kubo = rpc({ name: 'Orivon\'s node', base: process.env.KUBO_RPC ?? 'http://127.0.0.1:5001' })
const filebase = rpc({ name: 'Filebase', base: process.env.FILEBASE_RPC ?? 'https://rpc.filebase.io', key: KEY })
const INCOMING = join(STATE_DIR, 'incoming')
/** One copy, what is kept at once, and what one address sends in a day: provisional, they share the Filebase account with Orivon's own pins. */
const CAR_BYTES = Number(process.env.CAR_BYTES ?? LIMITS.carBytes)
const LIVE_BYTES = Number(process.env.LIVE_BYTES ?? 1024 ** 3)
const DAY_BYTES = Number(process.env.DAY_BYTES ?? 512 * 1024 ** 2)
const REQUESTS_PER_CLIENT = 60
const COPIES_PER_CLIENT = 10
/** Copies handled at once: each streams to disk, so the limit is the disk and the node's work. */
const AT_ONCE = 2
/** A copy that sends nothing for this long, or averages less than MIN_RATE bytes a second after a minute, is stopped. */
const STALL_MS = 30_000
const MIN_RATE = 20 * 1024
const ELSEWHERE = 'Try again later, or keep the share with a service of your own.'
const ENDPOINTS = ['/api/v0/keep', '/api/v0/status']

if (KEY === '') {
  console.error('FILEBASE_KEY is not set: the service has no account to pin with')
  process.exit(1)
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400'
}

/** Requests, copies and bytes counted per client for the current UTC day only. */
const counts = { day: '', requests: new Map(), copies: new Map(), bytes: new Map() }
/** Clients and CIDs with a copy under way, how many copies are, and the bytes they may still add. */
const busy = { clients: new Set(), cids: new Set(), copies: 0, bytes: 0 }

function today () {
  const day = new Date().toISOString().slice(0, 10)
  if (counts.day !== day) Object.assign(counts, { day, requests: new Map(), copies: new Map(), bytes: new Map() })
}

/**
 * Who a request comes from, for counting only: the address Caddy appended last to X-Forwarded-For, and an IPv6
 * address by its /64, which one subscriber holds whole.
 * @param {import('node:http').IncomingMessage} req
 */
function clientOf (req) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((a) => a.trim()).filter(Boolean)
  const address = forwarded.at(-1) ?? req.socket.remoteAddress ?? ''
  if (!address.includes(':')) return address
  const groups = address.split('::')[0]?.split(':') ?? []
  return `${groups.slice(0, 4).join(':')}::/64`
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {string} body @param {string} [type] */
function send (res, status, body, type = 'application/json') {
  res.writeHead(status, { ...CORS, 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

/** Kubo's own error shape. @param {import('node:http').ServerResponse} res @param {number} status @param {string} message */
function refuse (res, status, message) {
  if (res.headersSent) return res.end()
  send(res, status, JSON.stringify({ Message: message, Code: 0, Type: 'error' }))
}

/**
 * The CAR as a stream that leaves the connection alone when it is cancelled, so a refusal can still be sent. A
 * sender that stalls for 30 s, or after the first minute averages under 20 KiB/s, is stopped: it holds one of
 * the few copy slots.
 * @param {import('node:http').IncomingMessage} req @returns {ReadableStream<Uint8Array>}
 */
function bodyOf (req) {
  const chunks = req[Symbol.asyncIterator]()
  const started = Date.now()
  let received = 0
  return new ReadableStream({
    async pull (controller) {
      /** @type {NodeJS.Timeout | undefined} */
      let timer
      const stalled = new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error('The upload stalled.')) }, STALL_MS) })
      try {
        const { value, done } = await Promise.race([chunks.next(), stalled])
        if (done) return controller.close()
        received += value.length
        const elapsed = Date.now() - started
        if (elapsed > 60_000 && received < (elapsed / 1000) * MIN_RATE) throw new Error('The upload is too slow.')
        controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.length))
      } finally {
        clearTimeout(timer)
      }
    }
  })
}

/** @param {string | null} text */
function cidOf (text) {
  try {
    return parseCid(text ?? '').string
  } catch {
    throw new Refusal(400, 'That is not an IPFS address.')
  }
}

/** @param {number} at @param {string} cid @param {number} bytes */
const answer = (at, cid, bytes) => `${JSON.stringify({ Name: 'share', Hash: cid, Size: String(bytes), KeptUntil: new Date(endsAt(at)).toISOString() })}\n`

/**
 * Whether the copy of `cid` the record shows is still held where the service pinned it. One that is not (an
 * upload cut short by a crash) is forgotten, so it can be made again.
 * @param {import('./store.mjs').Pin | undefined} known @param {string} cid
 */
async function stillHeld (known, cid) {
  if (known === undefined || known.expired) return false
  if ((!known.kubo || await kubo.pinned(cid)) && (!known.filebase || await filebase.pinned(cid))) return true
  await markDropped(pinsFile(STATE_DIR), cid)
  return false
}

/**
 * Whether a copy of up to `size` bytes may be taken from `client` now: the CID is not taken down, and the
 * budgets have room. Throws the refusal, in the words the page shows.
 * @param {string} client @param {string} cid @param {number} size @param {Map<string, import('./store.mjs').Pin>} pins
 */
async function admit (client, cid, size, pins) {
  if ((await readBlocked(blockedFile(STATE_DIR))).has(cid)) throw new Refusal(403, 'Orivon\'s server does not keep this share.')
  if (size > CAR_BYTES) throw new Refusal(413, TOO_LARGE)
  today()
  if ((counts.copies.get(client) ?? 0) >= COPIES_PER_CLIENT) throw new Refusal(429, `Orivon's server keeps ${COPIES_PER_CLIENT} copies a day from one address. Try again tomorrow, or keep the share with a service of your own.`)
  if ((counts.bytes.get(client) ?? 0) + size > DAY_BYTES) throw new Refusal(429, `Orivon's server takes ${Math.floor(DAY_BYTES / 1024 ** 2)} MiB a day from one address. Try again tomorrow, or keep the share with a service of your own.`)
  if (usage(pins, 0).live + busy.bytes + size > LIVE_BYTES) throw new Refusal(503, `Orivon's server has no room for another copy right now. Try again tomorrow. ${ELSEWHERE}`)
}

/** How many bytes the request says it carries. @param {import('node:http').IncomingMessage} req */
function declared (req) {
  const text = req.headers['content-length']
  if (text === undefined) throw new Refusal(411, 'The upload says no size.')
  const size = Number(text)
  if (!Number.isSafeInteger(size) || size <= 0) throw new Refusal(400, 'The upload says no size.')
  if (size > CAR_BYTES) throw new Refusal(413, TOO_LARGE)
  return size
}

/**
 * Whether `cid` is kept now (the page then sends nothing), and if not whether a copy of `size` bytes would be
 * taken: the same checks a copy meets, answered before the page sends a byte.
 * @param {import('node:http').ServerResponse} res @param {string} client @param {URL} url
 */
async function status (res, client, url) {
  const cid = cidOf(url.searchParams.get('arg'))
  const size = Number(url.searchParams.get('size') ?? 0)
  const pins = await readPins(pinsFile(STATE_DIR))
  const known = pins.get(cid)
  if (await stillHeld(known, cid)) return send(res, 200, answer(/** @type {import('./store.mjs').Pin} */ (known).at, cid, /** @type {import('./store.mjs').Pin} */ (known).bytes))
  await admit(client, cid, Number.isFinite(size) && size > 0 ? size : 1, pins)
  send(res, 200, `${JSON.stringify({ Name: 'share', Hash: cid, KeptUntil: null })}\n`)
}

/**
 * Takes a share: checks the CAR into a file, imports it on the node and on the account, and returns the answer
 * the page expects, with `KeptUntil`. Its file and its claim on the share are gone before it returns, so a sender
 * that asks again at once finds the share free.
 * @param {import('node:http').IncomingMessage} req @param {string} client @param {URL} url @returns {Promise<string>}
 */
async function keep (req, client, url) {
  const cid = cidOf(url.searchParams.get('arg'))
  const size = declared(req)
  const file = pinsFile(STATE_DIR)
  const pins = await readPins(file)
  const known = pins.get(cid)
  if (await stillHeld(known, cid)) {
    req.resume()
    return answer(/** @type {import('./store.mjs').Pin} */ (known).at, cid, /** @type {import('./store.mjs').Pin} */ (known).bytes)
  }
  await admit(client, cid, size, pins)
  if (busy.cids.has(cid)) throw new Refusal(429, 'This share is being copied right now. Try again in a minute.')
  busy.cids.add(cid)
  busy.bytes += size
  const path = join(INCOMING, `${randomBytes(12).toString('hex')}.car`)
  try {
    const out = await open(path, 'w', 0o600)
    let bytes
    try {
      ;({ bytes } = await checkCar(bodyOf(req), cid, async (chunk) => { await out.appendFile(chunk) }, CAR_BYTES))
    } finally {
      await out.close()
    }
    const ownsKubo = !(await kubo.pinned(cid))
    const ownsFilebase = !(await filebase.pinned(cid))
    const at = Date.now()
    // The old copy of a share whose month is over is forgotten first, so a reader of the record sees one live pin.
    if (known !== undefined) await markDropped(file, cid)
    // Written before the import, so a crash after the node pinned still leaves a pin the expiry job ends.
    await addPin(file, { cid, at, bytes, kubo: ownsKubo, filebase: ownsFilebase, expired: false })
    try {
      if (ownsKubo) await kubo.importCar(cid, path)
      if (ownsFilebase) await filebase.importCar(cid, path)
    } catch (error) {
      console.error(`[share-copy] keeping ${cid} failed:`, error instanceof Error ? error.message : error)
      if (ownsKubo) await kubo.unpin(cid).catch((e) => { console.error(`[share-copy] could not unpin ${cid} from the node:`, e instanceof Error ? e.message : e) })
      if (ownsFilebase) await filebase.unpin(cid).catch((e) => { console.error(`[share-copy] could not unpin ${cid} from Filebase:`, e instanceof Error ? e.message : e) })
      await markDropped(file, cid)
      throw new Refusal(502, `Orivon's server could not keep the share right now. ${ELSEWHERE}`)
    }
    counts.copies.set(client, (counts.copies.get(client) ?? 0) + 1)
    counts.bytes.set(client, (counts.bytes.get(client) ?? 0) + bytes)
    console.log(`[share-copy] kept ${cid} (${bytes} bytes) until ${new Date(endsAt(at)).toISOString().slice(0, 10)}${ownsKubo && ownsFilebase ? '' : ', already pinned in part'}`)
    return answer(at, cid, bytes)
  } finally {
    busy.cids.delete(cid)
    busy.bytes -= size
    await rm(path, { force: true })
  }
}

/**
 * Answers a refusal in its own words, and anything else as a failure. The rest of the upload is read and
 * dropped, so the connection lives to carry the answer.
 * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {unknown} error
 */
function fail (req, res, error) {
  req.resume()
  if (error instanceof Refusal) return refuse(res, error.status, error.message)
  console.error('[share-copy] failed:', error instanceof Error ? error.message : error)
  refuse(res, 500, `Orivon's server could not keep the share right now. ${ELSEWHERE}`)
}

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {Promise<unknown>} work */
const settle = (req, res, work) => work.catch((error) => { fail(req, res, error) })

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://copy')
  const path = url.pathname
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
    return
  }
  if (req.method === 'GET' && path === '/health') return send(res, 200, 'ok\n', 'text/plain')
  if (req.method === 'POST' && path === '/api/v0/version') return send(res, 200, JSON.stringify({ Version: 'share-copy/1', System: `Orivon Share copy, kept ${String(KEEP_DAYS)} days` }))
  if (req.method !== 'POST' || !ENDPOINTS.includes(path)) return refuse(res, 404, 'The copy service answers /api/v0/keep, /api/v0/status and /api/v0/version only.')

  today()
  const client = clientOf(req)
  const requests = counts.requests.get(client) ?? 0
  if (requests >= REQUESTS_PER_CLIENT) return void settle(req, res, Promise.reject(new Refusal(429, `Orivon's server takes ${REQUESTS_PER_CLIENT} requests a day from one address. Try again tomorrow.`)))
  counts.requests.set(client, requests + 1)
  if (path === '/api/v0/status') return void settle(req, res, status(res, client, url))
  if (busy.copies >= AT_ONCE || busy.clients.has(client)) return void settle(req, res, Promise.reject(new Refusal(503, 'Orivon\'s server is busy with other copies. Try again in a minute.')))
  busy.copies++
  busy.clients.add(client)
  // The slot is free before the answer goes out, so the next request of a sender that has its answer is not turned away as busy.
  const release = () => {
    busy.copies--
    busy.clients.delete(client)
  }
  keep(req, client, url).then(
    (body) => { release(); send(res, 200, body) },
    (error) => { release(); fail(req, res, error) }
  )
})
// A slow sender holds a slot; these bound how long (bodyOf stops a stalled one). A 200 MiB copy at 2 Mbit/s is under 15 minutes.
server.requestTimeout = 20 * 60_000
server.headersTimeout = 15_000
server.maxConnections = 32

await rm(INCOMING, { recursive: true, force: true })
await mkdir(INCOMING, { recursive: true })
server.listen(PORT, '127.0.0.1', () => { console.log(`[share-copy] listening on 127.0.0.1:${String(/** @type {import('node:net').AddressInfo} */ (server.address()).port)}`) })

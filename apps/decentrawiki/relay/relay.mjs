// DecentraWiki's free pinning: pins one published wiki on Orivon's Filebase account for KEEP_DAYS, once per
// CID. In Orivon the editor runs an IPFS node in its page, which dials the Kubo node beside this relay, and
// `/api/v0/pin-from` reads the wiki from it (from-node.mjs); elsewhere the editor uploads it to the
// Kubo-compatible `/api/v0/add`. The editor computes the CID itself and accepts the pin only when this answer
// names the same one, so the relay can fail a publish but never change a wiki. It runs behind Caddy on
// 127.0.0.1, keeps no address of anyone, and counts requests per client in memory only.
// Configuration: FILEBASE_KEY (required), PORT, STATE_DIR, FILEBASE_RPC, KUBO_RPC, LIVE_BYTES, DAY_BYTES.

import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { parseCid } from '../page/src/ipfs/cid.js'
import { importDirectory } from '../page/src/ipfs/unixfs.js'
import { isPeerId, kuboClient, readWiki, waitForPeer } from './from-node.mjs'
import { LIMITS, Refusal, boundaryOf, canonicalUpload, checkFiles, checkUpload, parseMultipart } from './rules.mjs'
import { KEEP_DAYS, addPin, endsAt, markDropped, pinsFile, readPins, usage } from './store.mjs'

const PORT = Number(process.env.PORT ?? 8092)
const STATE_DIR = process.env.STATE_DIR ?? '/var/lib/decentrawiki-relay'
const FILEBASE_RPC = (process.env.FILEBASE_RPC ?? 'https://rpc.filebase.io').replace(/\/+$/, '')
const KEY = process.env.FILEBASE_KEY ?? ''
const kubo = kuboClient(process.env.KUBO_RPC ?? 'http://127.0.0.1:5001')
/** How long the page's node has to appear among the Kubo node's peers. */
const PEER_WAIT_MS = 20_000
/** What free pinning keeps at once, and takes in a day: it shares the account with Orivon's own pins. */
const LIVE_BYTES = Number(process.env.LIVE_BYTES ?? 2 * 1024 ** 3)
const DAY_BYTES = Number(process.env.DAY_BYTES ?? 512 * 1024 ** 2)
const PINS_PER_CLIENT = 20
const REQUESTS_PER_CLIENT = 60
const PINS_PER_DAY = 300
/** Uploads handled at once: each holds up to about five copies of a 12 MiB body, under MemoryMax=300M. */
const AT_ONCE = 2
const DAY_MS = 24 * 60 * 60 * 1000
const ELSEWHERE = 'Try again later, or pin it with your own node or service.'

if (KEY === '') {
  console.error('FILEBASE_KEY is not set: the relay has no account to pin with')
  process.exit(1)
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400'
}

/** Requests and pins counted per client and overall, for the current UTC day only. */
const counts = { day: '', requests: new Map(), pins: new Map(), total: 0 }
/** Clients and CIDs with an upload under way, and how many uploads are. */
const busy = { clients: new Set(), cids: new Set(), uploads: 0 }

function today () {
  const day = new Date().toISOString().slice(0, 10)
  if (counts.day !== day) Object.assign(counts, { day, requests: new Map(), pins: new Map(), total: 0 })
}

/**
 * Who a request comes from, for counting only: the address Caddy appended last to X-Forwarded-For, and an
 * IPv6 address by its /64, which one subscriber holds whole.
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

/** Kubo's own error shape, which the editor reads the words from. @param {import('node:http').ServerResponse} res @param {number} status @param {string} message */
function refuse (res, status, message) {
  if (res.headersSent) return res.end()
  send(res, status, JSON.stringify({ Message: message, Code: 0, Type: 'error' }))
}

/** @param {import('node:http').IncomingMessage} req @returns {Promise<Uint8Array>} */
async function readBody (req) {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > LIMITS.bodyBytes) throw new Refusal(413, 'This wiki is too large for free pinning. Pin it with your own node or service.')
  /** @type {Buffer[]} */
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > LIMITS.bodyBytes) throw new Refusal(413, 'This wiki is too large for free pinning. Pin it with your own node or service.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, length)
}

/** @param {string} path @param {AbortSignal} signal */
async function filebase (path, signal) {
  return await fetch(`${FILEBASE_RPC}${path}`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, signal })
}

/**
 * Whether the account already pins `cid`, so its pin is not the relay's to end. Any answer but a clear
 * one refuses the upload: guessing "no" would let the expiry job unpin one of Orivon's own pins.
 * @param {string} cid
 */
async function alreadyPinned (cid) {
  const response = await filebase(`/api/v0/pin/ls?arg=${cid}&type=recursive`, AbortSignal.timeout(60_000))
  const text = await response.text()
  if (!response.ok) {
    if (/not pinned/i.test(text)) return false
    throw new Refusal(502, `The pinning service behind free pinning did not answer. ${ELSEWHERE}`)
  }
  let keys
  try {
    keys = JSON.parse(text)?.Keys
  } catch {
    keys = undefined
  }
  if (typeof keys !== 'object' || keys === null) throw new Refusal(502, `The pinning service behind free pinning did not answer. ${ELSEWHERE}`)
  return cid in keys
}

/** Ends a pin the relay started and could not finish; a failure here is logged and left to the operator. @param {string} cid */
async function unpin (cid) {
  try {
    const response = await filebase(`/api/v0/pin/rm?arg=${cid}`, AbortSignal.timeout(120_000))
    const text = await response.text()
    if (!response.ok && !/not pinned/i.test(text)) console.error(`[relay] could not unpin ${cid}: Filebase answered ${response.status}`)
  } catch (error) {
    console.error(`[relay] could not unpin ${cid}:`, error)
  }
}

/** An upload, as a Kubo `add`. @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {string} client */
async function add (req, res, client) {
  const boundary = boundaryOf(req.headers['content-type'])
  if (boundary === null) throw new Refusal(400, 'The upload is not a form this relay reads.')
  const body = await readBody(req)
  const { rootName, files } = await checkUpload(parseMultipart(body, boundary))
  await keep(res, client, rootName, files)
}

/**
 * A wiki read from the IPFS node in the editor page, `peer`, which dialed the Kubo node beside the relay.
 * @param {import('node:http').ServerResponse} res @param {string} client @param {URL} url
 */
async function pinFrom (res, client, url) {
  let cid
  try {
    cid = parseCid(url.searchParams.get('arg') ?? '').string
  } catch {
    throw new Refusal(400, 'That is not an IPFS address.')
  }
  const peer = url.searchParams.get('peer') ?? ''
  if (!isPeerId(peer)) throw new Refusal(400, 'That is not an IPFS node\'s id.')
  const known = (await readPins(pinsFile(STATE_DIR))).get(cid)
  if (known?.expired !== true && known !== undefined && await alreadyPinned(cid)) {
    return send(res, 200, `${JSON.stringify({ Name: 'wiki', Hash: cid, KeptUntil: new Date(endsAt(known.at)).toISOString() })}\n`)
  }
  if (known?.expired === true) throw new Refusal(409, 'This version was already kept free for a month. Pin it with your own node or service, or publish a new version.')
  if (busy.cids.has(cid)) throw new Refusal(429, 'This version is being pinned right now. Try again in a minute.')
  await waitForPeer(kubo, peer, PEER_WAIT_MS)
  const files = await checkFiles(await readWiki(kubo, cid))
  if ((await importDirectory(files)).cid !== cid) throw new Refusal(400, 'The node answered with something other than this wiki.')
  await keep(res, client, 'wiki', files)
}

/**
 * Pins one checked wiki on the Filebase account and answers as Kubo's `add` does, with `KeptUntil`.
 * @param {import('node:http').ServerResponse} res @param {string} client @param {string} rootName
 * @param {{ path: string, bytes: Uint8Array }[]} files
 */
async function keep (res, client, rootName, files) {
  const { cid, size } = await importDirectory(files)
  const bytes = files.reduce((sum, f) => sum + f.bytes.length, 0)
  const file = pinsFile(STATE_DIR)
  const pins = await readPins(file)
  const known = pins.get(cid)
  if (known?.expired === true) throw new Refusal(409, 'This version was already kept free for a month. Pin it with your own node or service, or publish a new version.')
  /** @param {number} at */
  const answer = (at) => `${JSON.stringify({ Name: rootName, Hash: cid, Size: String(size), KeptUntil: new Date(endsAt(at)).toISOString() })}\n`
  if (busy.cids.has(cid)) throw new Refusal(429, 'This version is being pinned right now. Try again in a minute.')
  if (known !== undefined) {
    if (await alreadyPinned(cid)) return send(res, 200, answer(known.at))
    // Recorded, but the account does not hold it: an upload cut short by a crash. Pin it afresh.
    await markDropped(file, cid)
  }

  today()
  const used = counts.pins.get(client) ?? 0
  if (used >= PINS_PER_CLIENT) throw new Refusal(429, `Free pinning takes ${PINS_PER_CLIENT} wikis a day from one address. Try again tomorrow, or pin it with your own node or service.`)
  const { live, recent } = usage(pins, Date.now() - DAY_MS)
  if (counts.total >= PINS_PER_DAY || recent + bytes > DAY_BYTES || live + bytes > LIVE_BYTES) {
    throw new Refusal(503, 'Free pinning is full for now. Try again tomorrow, or pin it with your own node or service.')
  }
  counts.pins.set(client, used + 1)
  counts.total++

  busy.cids.add(cid)
  try {
    const preexisting = await alreadyPinned(cid)
    const at = Date.now()
    // Written before the upload, so a crash after Filebase pinned still leaves a pin the expiry job ends.
    await addPin(file, { cid, at, bytes, preexisting, expired: false })
    const upload = canonicalUpload(rootName, files)
    let reported
    try {
      const forwarded = await fetch(`${FILEBASE_RPC}/api/v0/add?cid-version=1&pin=true&quieter=false&progress=false&wrap-with-directory=false`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': upload.contentType },
        body: upload.body,
        signal: AbortSignal.timeout(300_000)
      })
      const text = await forwarded.text()
      if (!forwarded.ok) throw new Error(`Filebase answered ${forwarded.status}`)
      reported = text.split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).find((entry) => entry?.Name === rootName)?.Hash
      if (reported !== cid) throw new Error(`Filebase reported ${String(reported)}`)
    } catch (error) {
      console.error(`[relay] pinning ${cid} failed:`, error instanceof Error ? error.message : error)
      if (!preexisting) {
        await unpin(cid)
        if (typeof reported === 'string' && reported !== cid) await unpin(reported)
      }
      await markDropped(file, cid)
      throw new Refusal(502, `The pinning service behind free pinning did not take the wiki. ${ELSEWHERE}`)
    }
    console.log(`[relay] pinned ${cid} (${bytes} bytes) until ${new Date(endsAt(at)).toISOString().slice(0, 10)}${preexisting ? ', already pinned before' : ''}`)
    send(res, 200, answer(at))
  } finally {
    busy.cids.delete(cid)
  }
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://relay').pathname
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
    return
  }
  if (req.method === 'GET' && path === '/health') return send(res, 200, 'ok\n', 'text/plain')
  if (req.method === 'POST' && path === '/api/v0/version') return send(res, 200, JSON.stringify({ Version: 'decentrawiki-relay/1', System: `DecentraWiki free pinning, kept ${String(KEEP_DAYS)} days` }))
  if (req.method !== 'POST' || (path !== '/api/v0/add' && path !== '/api/v0/pin-from')) return refuse(res, 404, 'Free pinning answers /api/v0/add, /api/v0/pin-from and /api/v0/version only.')

  today()
  const client = clientOf(req)
  const requests = counts.requests.get(client) ?? 0
  if (requests >= REQUESTS_PER_CLIENT) return refuse(res, 429, `Free pinning takes ${REQUESTS_PER_CLIENT} uploads a day from one address, failed ones included. Try again tomorrow.`)
  counts.requests.set(client, requests + 1)
  if (busy.uploads >= AT_ONCE || busy.clients.has(client)) return refuse(res, 503, 'Free pinning is busy. Try again in a minute.')
  busy.uploads++
  busy.clients.add(client)
  const work = path === '/api/v0/add' ? add(req, res, client) : pinFrom(res, client, new URL(req.url ?? '/', 'http://relay'))
  work.catch((error) => {
    if (error instanceof Refusal) return refuse(res, error.status, error.message)
    console.error('[relay] failed:', error)
    refuse(res, 500, `Free pinning failed. ${ELSEWHERE}`)
  }).finally(() => {
    busy.uploads--
    busy.clients.delete(client)
  })
})
// A slow sender holds an upload slot; these bound how long.
server.requestTimeout = 120_000
server.headersTimeout = 15_000
server.maxConnections = 32

await mkdir(STATE_DIR, { recursive: true })
server.listen(PORT, '127.0.0.1', () => { console.log(`[relay] listening on 127.0.0.1:${String(PORT)}`) })

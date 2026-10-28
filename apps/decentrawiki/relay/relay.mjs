// DecentraWiki's free pinning: pins one published wiki on Orivon's Filebase account for KEEP_DAYS, once per
// CID. In Orivon the editor runs an IPFS node in its page, which dials the Kubo node beside this relay, and
// `/api/v0/pin-from` reads the wiki from it (from-node.mjs); elsewhere the editor uploads it to the
// Kubo-compatible `/api/v0/add`. The editor computes the CID itself and accepts the pin only when this answer
// names the same one, so the relay can fail a publish but never change a wiki. It also keeps a wiki's IPNS
// name alive for KEEP_DAYS after each publish (`/api/v0/name/keep`, names.mjs): the editor signs the record
// with a key the relay never sees, and the relay puts it into the Kubo node, then republishes it every few
// hours (republish.mjs). A version the relay holds no pin of is read first, from the IPFS network, or, when
// the editor names its node with `peer`, over the same temporary peering `pin-from` uses, because a version
// hosted by the editor's node is found through the network only after minutes; a node that does not appear
// among Kubo's peers in time is given up on and the network is tried. It runs behind Caddy on
// 127.0.0.1, keeps no address of anyone, and counts requests per client in memory only.
// Configuration: FILEBASE_KEY (required), PORT, STATE_DIR, FILEBASE_RPC, KUBO_RPC, LIVE_BYTES, DAY_BYTES.

import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { parseCid } from '../page/src/ipfs/cid.js'
import { IPNS_RECORD_TYPE, MAX_RECORD_BYTES } from '../page/src/ipfs/ipns.js'
import { importDirectory } from '../page/src/ipfs/unixfs.js'
import { isPeerId, kuboClient, nodeAddress, readWiki, waitForPeer, whilePeered } from './from-node.mjs'
import { addChecked, addKeep, checkedName, judgeKeep, namesFile, putRecord, readNames, roomFor } from './names.mjs'
import { LIMITS, Refusal, boundaryOf, canonicalUpload, checkFiles, checkUpload, parseMultipart } from './rules.mjs'
import { KEEP_DAYS, addPin, endsAt, markDropped, pinsFile, readPins, usage } from './store.mjs'

const PORT = Number(process.env.PORT ?? 8092)
const STATE_DIR = process.env.STATE_DIR ?? '/var/lib/decentrawiki-relay'
const FILEBASE_RPC = (process.env.FILEBASE_RPC ?? 'https://rpc.filebase.io').replace(/\/+$/, '')
const KEY = process.env.FILEBASE_KEY ?? ''
const kubo = kuboClient(process.env.KUBO_RPC ?? 'http://127.0.0.1:5001')
/** How long the page's node has to appear among the Kubo node's peers, and a whole read from it may take. */
const PEER_WAIT_MS = 10_000
const READ_MS = 90_000
/** `/api/v0/node`'s answer, kept a minute so that asking it costs Kubo nothing. */
let nodeAnswer = { at: 0, body: '' }
/** What free pinning keeps at once, and takes in a day: it shares the account with Orivon's own pins. */
const LIVE_BYTES = Number(process.env.LIVE_BYTES ?? 2 * 1024 ** 3)
const DAY_BYTES = Number(process.env.DAY_BYTES ?? 512 * 1024 ** 2)
const PINS_PER_CLIENT = 20
const REQUESTS_PER_CLIENT = 60
const PINS_PER_DAY = 300
/** Names kept in a day for one client, and names kept live at once. */
const NAMES_PER_CLIENT = 20
const LIVE_NAMES = 500
/** Puts into Kubo under way at once: each takes about half a minute and the node is shared. */
const PUTS_AT_ONCE = 4
/** Uploads handled at once: each holds up to about five copies of a 12 MiB body, under MemoryMax=300M. */
const AT_ONCE = 2
const DAY_MS = 24 * 60 * 60 * 1000
const ELSEWHERE = 'Try again later, or pin it with your own node or service.'
const TOO_LARGE = 'This wiki is too large for free pinning. Pin it with your own node or service.'
const ENDPOINTS = ['/api/v0/add', '/api/v0/pin-from', '/api/v0/name/keep', '/api/v0/name/record']

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
const counts = { day: '', requests: new Map(), pins: new Map(), names: new Map(), total: 0 }
/** Clients and CIDs with an upload under way, how many uploads are, and the names and puts under way. */
const busy = { clients: new Set(), cids: new Set(), uploads: 0, names: new Set(), puts: 0 }

function today () {
  const day = new Date().toISOString().slice(0, 10)
  if (counts.day !== day) Object.assign(counts, { day, requests: new Map(), pins: new Map(), names: new Map(), total: 0 })
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

/** @param {import('node:http').ServerResponse} res @param {number} status @param {string | Uint8Array} body @param {string} [type] */
function send (res, status, body, type = 'application/json') {
  res.writeHead(status, { ...CORS, 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

/** Kubo's own error shape, which the editor reads the words from. @param {import('node:http').ServerResponse} res @param {number} status @param {string} message */
function refuse (res, status, message) {
  if (res.headersSent) return res.end()
  send(res, status, JSON.stringify({ Message: message, Code: 0, Type: 'error' }))
}

/** @param {import('node:http').IncomingMessage} req @param {number} [limit] @param {string} [tooLarge] @returns {Promise<Uint8Array>} */
async function readBody (req, limit = LIMITS.bodyBytes, tooLarge = TOO_LARGE) {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > limit) throw new Refusal(413, tooLarge)
  /** @type {Buffer[]} */
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > limit) throw new Refusal(413, tooLarge)
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
  const files = await checkFiles(await readFromPeer(peer, cid))
  if ((await importDirectory(files)).cid !== cid) throw new Refusal(400, 'The node answered with something other than this wiki.')
  await keep(res, client, 'wiki', files)
}

/**
 * A wiki read from the IPFS node in the editor page, which dialed the Kubo node beside the relay: Kubo
 * peers with it for as long as the read takes.
 * @param {string} peer @param {string} cid
 */
async function readFromPeer (peer, cid) {
  const addr = await waitForPeer(kubo, peer, PEER_WAIT_MS)
  const deadline = Date.now() + READ_MS
  return await whilePeered(kubo, peer, addr, async () => await readWiki(kubo, cid, deadline))
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

/**
 * The files of a version the relay holds no pin of: from the editor page's node when `peer` names it. A
 * version that node holds is found through the network only after minutes, but one that is pinned elsewhere
 * is found there, so a node Kubo is not connected to (409) is not the end: the network is tried within the
 * same READ_MS, and if it does not find the version either, the editor is told its node is not connected,
 * which it can mend by keeping the editor open. A node that is connected and fails the read says why.
 * @param {string | null} peer @param {string} cid
 */
async function readUnknown (peer, cid) {
  const until = Date.now() + READ_MS
  /** @type {Refusal | undefined} */
  let unconnected
  if (peer !== null) {
    try {
      return await readFromPeer(peer, cid)
    } catch (error) {
      // 409 is waitForPeer's alone; a failed read or a failed check from a connected node is not retried.
      if (!(error instanceof Refusal && error.status === 409)) throw error
      unconnected = error
    }
  }
  try {
    return await readWiki(kubo, cid, until, 'network')
  } catch (error) {
    throw unconnected !== undefined && error instanceof Refusal && error.status === 504 ? unconnected : error
  }
}

/**
 * Reads a version nobody uploaded through Kubo and checks it as an upload is, so the relay keeps names of
 * wikis and never of arbitrary files: from the editor page's node when `peer` names it and Kubo is connected
 * to it, else from the IPFS network. It takes an upload slot as `add` and `pin-from` do.
 * @param {string} client @param {string} cid @param {string} file @param {string | null} peer
 */
async function readVersion (client, cid, file, peer) {
  if (busy.uploads >= AT_ONCE || busy.clients.has(client)) throw new Refusal(503, 'Free pinning is busy. Try again in a minute.')
  busy.uploads++
  busy.clients.add(client)
  try {
    try {
      const read = await readUnknown(peer, cid)
      const files = await checkFiles(read)
      if ((await importDirectory(files)).cid !== cid) throw new Refusal(400, 'The node answered with something other than this wiki.')
    } catch (error) {
      if (error instanceof Refusal && (error.status === 400 || error.status === 413)) {
        throw new Refusal(error.status, `Orivon's node keeps no name for this version. ${error.message}`)
      }
      throw error
    }
    await addChecked(file, cid)
  } finally {
    busy.uploads--
    busy.clients.delete(client)
  }
}

/**
 * Keeps a wiki's IPNS name for KEEP_DAYS: the editor's signed record is checked (names.mjs judgeKeep), the
 * version it points at is a known pin or is read and checked (from the editor's node when the optional
 * `peer` names it and Kubo is connected to it, else from the IPFS network), and Kubo puts the record on the
 * network.
 * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {string} client @param {URL} url
 */
async function nameKeep (req, res, client, url) {
  const body = await readBody(req, MAX_RECORD_BYTES, `That is not an IPNS record: a record is at most ${MAX_RECORD_BYTES} bytes.`)
  const name = checkedName(url.searchParams.get('arg') ?? '')
  const peer = url.searchParams.get('peer')
  if (peer !== null && !isPeerId(peer)) throw new Refusal(400, 'That is not an IPFS node\'s id.')
  if (busy.names.has(name)) throw new Refusal(429, 'This name is being kept right now. Try again in a minute.')
  busy.names.add(name)
  try {
    const file = namesFile(STATE_DIR)
    const now = Date.now()
    const state = await readNames(file)
    const judged = await judgeKeep({ name, body, state, pins: await readPins(pinsFile(STATE_DIR)), now })
    /** @param {number} at */
    const answer = (at) => `${JSON.stringify({ Name: name, Value: `/ipfs/${judged.cid}`, Sequence: judged.sequence, KeptUntil: new Date(endsAt(at)).toISOString() })}\n`
    if (judged.already !== undefined) return send(res, 200, answer(judged.already.at))

    today()
    const used = counts.names.get(client) ?? 0
    if (used >= NAMES_PER_CLIENT) throw new Refusal(429, `Orivon's node keeps ${NAMES_PER_CLIENT} names a day for one address. Try again tomorrow.`)
    if (!roomFor(state, name, now, LIVE_NAMES)) throw new Refusal(503, 'Orivon\'s node keeps as many names as it can for now. Try again tomorrow.')
    if (judged.needsRead) await readVersion(client, judged.cid, file, peer)
    if (busy.puts >= PUTS_AT_ONCE) throw new Refusal(503, 'Free pinning is busy. Try again in a minute.')
    busy.puts++
    try {
      await putRecord(kubo, name, body)
    } catch (error) {
      console.error(`[relay] could not put the record of ${name}:`, error instanceof Error ? error.message : error)
      throw new Refusal(502, 'Orivon\'s node could not publish the name right now. Try again in a few minutes.')
    } finally {
      busy.puts--
    }
    const at = Date.now()
    await addKeep(file, { name, cid: judged.cid, sequence: judged.sequence, record: body, at })
    counts.names.set(client, (counts.names.get(client) ?? 0) + 1)
    console.log(`[relay] kept ${name} -> ${judged.cid} (sequence ${judged.sequence}) until ${new Date(endsAt(at)).toISOString().slice(0, 10)}`)
    send(res, 200, answer(at))
  } finally {
    busy.names.delete(name)
  }
}

/** The newest record held for a name, live or ended: how the editor learns a name's sequence and version. @param {import('node:http').ServerResponse} res @param {URL} url */
async function nameRecord (res, url) {
  const held = (await readNames(namesFile(STATE_DIR))).names.get(checkedName(url.searchParams.get('arg') ?? ''))
  if (held === undefined) throw new Refusal(404, 'Orivon\'s node holds no record for this name.')
  send(res, 200, held.record, IPNS_RECORD_TYPE)
}

/**
 * Answers a refusal in its own words, and anything else as a failure.
 * @param {import('node:http').ServerResponse} res @param {Promise<unknown>} work @param {string} failed
 */
function settle (res, work, failed) {
  return work.catch((error) => {
    if (error instanceof Refusal) return refuse(res, error.status, error.message)
    console.error('[relay] failed:', error)
    refuse(res, 500, failed)
  })
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://relay').pathname
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
    return
  }
  if (req.method === 'GET' && path === '/health') return send(res, 200, 'ok\n', 'text/plain')
  if (req.method === 'POST' && path === '/api/v0/version') return send(res, 200, JSON.stringify({ Version: 'decentrawiki-relay/3', System: `DecentraWiki free pinning, wikis and IPNS names kept ${String(KEEP_DAYS)} days` }))
  if (req.method === 'POST' && path === '/api/v0/node') {
    if (Date.now() - nodeAnswer.at < 60_000) return send(res, 200, nodeAnswer.body)
    nodeAddress(kubo).then((node) => {
      nodeAnswer = { at: Date.now(), body: JSON.stringify(node) }
      send(res, 200, nodeAnswer.body)
    }, (error) => refuse(res, error instanceof Refusal ? error.status : 503, error instanceof Refusal ? error.message : 'Orivon\'s node is not reachable right now. Try again later.'))
    return
  }
  if (req.method !== 'POST' || !ENDPOINTS.includes(path)) return refuse(res, 404, 'Free pinning answers /api/v0/add, /api/v0/pin-from, /api/v0/name/keep, /api/v0/name/record, /api/v0/node and /api/v0/version only.')

  today()
  const client = clientOf(req)
  const requests = counts.requests.get(client) ?? 0
  if (requests >= REQUESTS_PER_CLIENT) return refuse(res, 429, `Free pinning takes ${REQUESTS_PER_CLIENT} uploads a day from one address, failed ones included. Try again tomorrow.`)
  counts.requests.set(client, requests + 1)
  const url = new URL(req.url ?? '/', 'http://relay')
  const namesFailed = 'Orivon\'s node could not keep the name right now. Try again in a few minutes.'
  if (path === '/api/v0/name/record') return void settle(res, nameRecord(res, url), namesFailed)
  if (path === '/api/v0/name/keep') return void settle(res, nameKeep(req, res, client, url), namesFailed)
  if (busy.uploads >= AT_ONCE || busy.clients.has(client)) return refuse(res, 503, 'Free pinning is busy. Try again in a minute.')
  busy.uploads++
  busy.clients.add(client)
  settle(res, path === '/api/v0/add' ? add(req, res, client) : pinFrom(res, client, url), `Free pinning failed. ${ELSEWHERE}`).finally(() => {
    busy.uploads--
    busy.clients.delete(client)
  })
})
// A slow sender holds an upload slot; these bound how long.
server.requestTimeout = 120_000
server.headersTimeout = 15_000
server.maxConnections = 32

await mkdir(STATE_DIR, { recursive: true })
server.listen(PORT, '127.0.0.1', () => { console.log(`[relay] listening on 127.0.0.1:${String(/** @type {import('node:net').AddressInfo} */ (server.address()).port)}`) })

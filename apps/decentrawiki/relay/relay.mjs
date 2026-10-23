// DecentraWiki's free pinning: a Kubo-compatible `/api/v0/add` that pins one published wiki on Orivon's
// Filebase account for KEEP_DAYS, once per CID. The editor computes the CID itself and accepts the pin
// only when this answer names the same one, so the relay can fail a publish but never change a wiki.
// It runs behind Caddy on 127.0.0.1, keeps no address of anyone, and counts uploads per client in
// memory only. Configuration: FILEBASE_KEY (required), PORT, STATE_DIR, FILEBASE_RPC.

import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { importDirectory } from '../page/src/ipfs/unixfs.js'
import { LIMITS, Refusal, boundaryOf, checkUpload, parseMultipart } from './rules.mjs'
import { KEEP_DAYS, addPin, endsAt, pinsFile, readPins } from './store.mjs'

const PORT = Number(process.env.PORT ?? 8092)
const STATE_DIR = process.env.STATE_DIR ?? '/var/lib/decentrawiki-relay'
const FILEBASE_RPC = (process.env.FILEBASE_RPC ?? 'https://rpc.filebase.io').replace(/\/+$/, '')
const KEY = process.env.FILEBASE_KEY ?? ''
const PER_CLIENT_PER_DAY = 20
const PER_DAY = 300

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

/** Uploads counted per client and overall, for the current UTC day only. */
const counts = { day: '', clients: new Map(), total: 0 }

/** @param {string} client */
function admit (client) {
  const day = new Date().toISOString().slice(0, 10)
  if (counts.day !== day) {
    counts.day = day
    counts.clients = new Map()
    counts.total = 0
  }
  const used = counts.clients.get(client) ?? 0
  if (used >= PER_CLIENT_PER_DAY) throw new Refusal(429, 'Free pinning takes 20 wikis a day from one address. Try again tomorrow, or pin with your own node or service.')
  if (counts.total >= PER_DAY) throw new Refusal(503, 'Free pinning is full for today. Try again tomorrow, or pin with your own node or service.')
  counts.clients.set(client, used + 1)
  counts.total++
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {string} body @param {string} [type] */
function send (res, status, body, type = 'application/json') {
  res.writeHead(status, { ...CORS, 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

/** Kubo's own error shape, which the editor reads the words from. @param {import('node:http').ServerResponse} res @param {number} status @param {string} message */
function refuse (res, status, message) {
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
  return new Uint8Array(Buffer.concat(chunks))
}

/** Whether the account already pins `cid`, so its pin is not the relay's to end. @param {string} cid */
async function alreadyPinned (cid) {
  const response = await fetch(`${FILEBASE_RPC}/api/v0/pin/ls?arg=${cid}&type=recursive`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(60_000) })
  if (!response.ok) return false
  const answer = await response.json().catch(() => ({}))
  return typeof answer?.Keys === 'object' && answer.Keys !== null && cid in answer.Keys
}

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
async function add (req, res) {
  const boundary = boundaryOf(req.headers['content-type'])
  if (boundary === null) throw new Refusal(400, 'The upload is not a form this relay reads.')
  const body = await readBody(req)
  const { rootName, files } = await checkUpload(parseMultipart(body, boundary))
  const { cid } = await importDirectory(files)
  const file = pinsFile(STATE_DIR)
  const known = (await readPins(file)).get(cid)
  if (known?.expired === true) throw new Refusal(409, 'This version was already kept free for a month. Pin it with your own node or service, or publish a new version.')
  const line = JSON.stringify({ Name: rootName, Hash: cid, Size: String(body.length) })
  if (known !== undefined) {
    send(res, 200, `${line}\n`)
    return
  }
  admit(String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0]?.trim() ?? '')
  const preexisting = await alreadyPinned(cid)
  const forwarded = await fetch(`${FILEBASE_RPC}/api/v0/add?cid-version=1&pin=true&quieter=false&progress=false&wrap-with-directory=false`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': String(req.headers['content-type']) },
    body,
    signal: AbortSignal.timeout(300_000)
  })
  const text = await forwarded.text()
  if (!forwarded.ok) {
    console.error(`[relay] Filebase answered ${forwarded.status} for ${cid}`)
    throw new Refusal(502, 'The pinning service behind free pinning did not take the wiki. Try again later, or pin with your own node or service.')
  }
  const root = text.split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).find((entry) => entry?.Name === rootName)
  if (root?.Hash !== cid) {
    console.error(`[relay] Filebase reported ${String(root?.Hash)} for ${cid}`)
    throw new Refusal(502, 'The pinning service stored something other than this wiki, so it was not kept.')
  }
  await addPin(file, { cid, at: Date.now(), bytes: body.length, preexisting, expired: false })
  console.log(`[relay] pinned ${cid} (${body.length} bytes) until ${new Date(endsAt(Date.now())).toISOString().slice(0, 10)}${preexisting ? ', already pinned before' : ''}`)
  send(res, 200, text)
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
  if (req.method !== 'POST' || path !== '/api/v0/add') return refuse(res, 404, 'Free pinning answers /api/v0/add and /api/v0/version only.')
  add(req, res).catch((error) => {
    if (error instanceof Refusal) return refuse(res, error.status, error.message)
    console.error('[relay] failed:', error)
    refuse(res, 500, 'Free pinning failed. Try again later, or pin with your own node or service.')
  })
})

await mkdir(STATE_DIR, { recursive: true })
server.listen(PORT, '127.0.0.1', () => { console.log(`[relay] listening on 127.0.0.1:${String(PORT)}`) })

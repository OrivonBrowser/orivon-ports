// The IPNS names free pinning keeps alive: a name is kept for KEEP_DAYS after each publish, and put back on
// the network every few hours (republish.mjs), because a record signed for ten years can be republished by
// whoever holds it. The record is JSON lines in the state directory, only ever appended to, like store.mjs:
//   keep     { name, cid, sequence, record: <base64>, at }   the relay published this record and keeps the name
//   checked  { cid, checked: true, at }                      a version not pinned here that was read and checked
//   ended    { name, ended: true, at }                       the name is no longer republished (a later keep revives it)
//   blocked  { cid, blocked: true, at }                      a version taken down: no name may point at it again
// A line cut short by a crash is skipped. No line names who asked. The rules (judgeKeep, liveNames) are
// pure, so the server, the republisher and the tests share them.

import { appendFile, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DAG_PB, SHA2_256, bytesEqual, parseCid } from '../page/src/ipfs/cid.js'
import { IpnsError, parseName, parseRecord, verifyRecord } from '../page/src/ipfs/ipns.js'
import { buildMultipart } from '../page/src/publish/multipart.js'
import { Refusal } from './rules.mjs'
import { KEEP_DAYS } from './store.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
/** A put into the DHT takes about half a minute on the real host. */
const PUT_MS = 120_000

/**
 * @typedef {{ name: string, cid: string, sequence: number, record: Uint8Array, at: number, ended: boolean }} KeptName
 * @typedef {{ names: Map<string, KeptName>, checked: Set<string>, blocked: Set<string> }} NamesState
 */

/** @param {string} dir */
export function namesFile (dir) {
  return join(dir, 'names.jsonl')
}

/** @param {string} file @returns {Promise<NamesState>} */
export async function readNames (file) {
  /** @type {NamesState} */
  const state = { names: new Map(), checked: new Set(), blocked: new Set() }
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    if (entry.blocked === true && typeof entry.cid === 'string') state.blocked.add(entry.cid)
    else if (entry.checked === true && typeof entry.cid === 'string') state.checked.add(entry.cid)
    else if (entry.ended === true && typeof entry.name === 'string') {
      const known = state.names.get(entry.name)
      if (known !== undefined) known.ended = true
    } else if (typeof entry.name === 'string' && typeof entry.cid === 'string' && typeof entry.record === 'string' && BASE64.test(entry.record)) {
      // The newest keep line of a name stands, and revives a name that was ended.
      state.names.set(entry.name, {
        name: entry.name,
        cid: entry.cid,
        sequence: Number(entry.sequence) || 0,
        record: new Uint8Array(Buffer.from(entry.record, 'base64')),
        at: Number(entry.at) || 0,
        ended: false
      })
    }
  }
  return state
}

/** @param {string} file @param {{ name: string, cid: string, sequence: number, record: Uint8Array, at: number }} kept */
export async function addKeep (file, { name, cid, sequence, record, at }) {
  await appendFile(file, `${JSON.stringify({ name, cid, sequence, record: Buffer.from(record).toString('base64'), at })}\n`)
}

/** @param {string} file @param {string} cid @param {number} [at] */
export async function addChecked (file, cid, at = Date.now()) {
  await appendFile(file, `${JSON.stringify({ cid, checked: true, at })}\n`)
}

/** @param {string} file @param {string} name @param {number} [at] */
export async function addEnded (file, name, at = Date.now()) {
  await appendFile(file, `${JSON.stringify({ name, ended: true, at })}\n`)
}

/** @param {string} file @param {string} cid @param {number} [at] */
export async function addBlocked (file, cid, at = Date.now()) {
  await appendFile(file, `${JSON.stringify({ cid, blocked: true, at })}\n`)
}

/** Why a kept name is no longer republished, or null while it is live. @param {KeptName} entry @param {NamesState} state @param {number} now */
function lapse (entry, state, now) {
  if (entry.ended) return 'ended'
  if (now - entry.at >= KEEP_DAYS * DAY_MS) return 'its days are over'
  if (state.blocked.has(entry.cid)) return 'its version was taken down'
  try {
    if (parseRecord(entry.record).validUntil <= now) return 'its record ran out'
  } catch {
    return 'its record is unreadable'
  }
  return null
}

/** The newest record of each name to republish. @param {NamesState} state @param {number} now */
export function liveNames (state, now) {
  return [...state.names.values()].filter((entry) => lapse(entry, state, now) === null)
}

/** The names not yet ended whose time is up, whose version was taken down or whose record ran out. @param {NamesState} state @param {number} now */
export function lapsedNames (state, now) {
  return [...state.names.values()].filter((entry) => !entry.ended && lapse(entry, state, now) !== null)
}

/** Whether Orivon's node can keep one more name: a live name always can be kept again. @param {NamesState} state @param {string} name @param {number} now @param {number} cap */
export function roomFor (state, name, now, cap) {
  const live = liveNames(state, now)
  return live.some((entry) => entry.name === name) || live.length < cap
}

/** The canonical name, or a 400 in the IPNS module's own words. @param {string} text */
export function checkedName (text) {
  try {
    return parseName(text).name
  } catch (error) {
    if (error instanceof IpnsError) throw new Refusal(400, error.message)
    throw error
  }
}

/**
 * Decides whether Orivon's node keeps a name for the record it was sent, in the order the editor's person
 * can act on: the name, the record, how long it stays valid, what it points at, then the name's history.
 * `needsRead` says the version must first be read from IPFS and checked as an upload is; `already` is the
 * stored name when this very record is kept already.
 * @param {{ name: string, body: Uint8Array, state: NamesState, pins: Map<string, import('./store.mjs').Pin>, now: number }} input
 * @returns {Promise<{ name: string, cid: string, record: Uint8Array, sequence: number, needsRead: boolean, already: KeptName | undefined }>}
 */
export async function judgeKeep ({ name, body, state, pins, now }) {
  const canonical = checkedName(name)
  let record
  try {
    record = await verifyRecord(body, canonical, { now })
  } catch (error) {
    if (error instanceof IpnsError) throw new Refusal(400, error.message)
    throw error
  }
  if (record.validUntil < now + KEEP_DAYS * DAY_MS) {
    throw new Refusal(400, `This IPNS record runs out at ${record.validity}, sooner than the ${KEEP_DAYS} days Orivon's node keeps a name. Sign it for a longer time.`)
  }
  const value = /^\/ipfs\/([^/]+)$/.exec(record.value)
  let cid
  try {
    cid = parseCid(value?.[1] ?? '')
  } catch {
    cid = undefined
  }
  if (cid === undefined || cid.version !== 1 || cid.codec !== DAG_PB || cid.hashCode !== SHA2_256) {
    throw new Refusal(400, 'This name does not point at a wiki: its record has to say /ipfs/ and the address of one wiki (one IPFS folder), with nothing after it.')
  }
  if (state.blocked.has(cid.string)) throw new Refusal(410, 'This version of the wiki was taken down, so Orivon\'s node keeps no name for it.')
  const stored = state.names.get(canonical)
  let already
  if (stored !== undefined && lapse(stored, state, now) === null) {
    if (stored.sequence > record.sequence) {
      throw new Refusal(409, `A newer version of this name was published already, at sequence ${stored.sequence}. Sign the record again with a higher sequence number.`)
    }
    if (stored.sequence === record.sequence) {
      if (!bytesEqual(stored.record, body)) {
        throw new Refusal(409, `A different record with the same sequence number (${stored.sequence}) was published already. Sign it again with a higher sequence number.`)
      }
      already = stored
    }
  }
  const pin = pins.get(cid.string)
  const known = (pin !== undefined && !pin.expired) || state.checked.has(cid.string)
  return { name: canonical, cid: cid.string, record: body, sequence: record.sequence, needsRead: already === undefined && !known, already }
}

/**
 * Puts a record into Orivon's Kubo node, which publishes it to the network: a record Kubo already holds
 * is accepted again, so this is how a name is kept and how it is put back.
 * @param {import('./from-node.mjs').Kubo} kubo @param {string} name @param {Uint8Array} record
 */
export async function putRecord (kubo, name, record) {
  const { body, contentType } = buildMultipart([{ name: 'file', filename: 'record', contentType: 'application/octet-stream', bytes: record }])
  await kubo(`routing/put?arg=${encodeURIComponent(`/ipns/${name}`)}`, { timeoutMs: PUT_MS, maxBytes: 1024 * 1024, body, contentType })
}

/**
 * Ends the names whose time is up, then puts every live name back, `atOnce` at a time. Before each put it
 * looks at the record again when the file grew, so a name taken down or renewed meanwhile is not put back stale.
 * @param {{ kubo: import('./from-node.mjs').Kubo, file: string, now?: number, atOnce?: number }} options
 * @returns {Promise<{ republished: number, failed: number, ended: number }>}
 */
export async function republishNames ({ kubo, file, now = Date.now(), atOnce = 2 }) {
  let state = await readNames(file)
  let size = await sizeOf(file)
  const lapsed = lapsedNames(state, now)
  for (const entry of lapsed) await addEnded(file, entry.name, now)
  const queue = liveNames(state, now).map((entry) => entry.name)
  let republished = 0
  let failed = 0
  const worker = async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      const grown = await sizeOf(file)
      if (grown !== size) {
        state = await readNames(file)
        size = grown
      }
      const entry = state.names.get(name)
      if (entry === undefined || lapse(entry, state, Date.now()) !== null) continue
      try {
        await putRecord(kubo, name, entry.record)
        republished++
      } catch (error) {
        failed++
        console.error(`[republish] could not put ${name} back: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  await Promise.all(Array.from({ length: atOnce }, worker))
  return { republished, failed, ended: lapsed.length }
}

/** @param {string} file */
async function sizeOf (file) {
  try {
    return (await stat(file)).size
  } catch {
    return 0
  }
}

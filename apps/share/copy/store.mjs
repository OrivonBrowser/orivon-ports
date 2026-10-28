// What the copy service kept and when: JSON lines in the state directory, only ever appended, so the service and
// the daily expiry job (expire.mjs) can write at once without losing a line. A CID's pin line holds its time, its
// size and where the service pinned it (`kubo`, `filebase`: false when the node or the account held it before,
// so the service never unpins it); an `expired` line ends it, and a `dropped` line forgets it (a pin that failed
// half-way, or one a new copy replaces). The lines are the shape the Filebase mirror job reads to spare a live pin.
// A taken-down CID is a line of `blocked.jsonl`. No line names who sent a share.

import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const KEEP_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * @typedef {{ cid: string, at: number, bytes: number, kubo: boolean, filebase: boolean, expired: boolean }} Pin
 */

/** @param {string} dir */
export function pinsFile (dir) {
  return join(dir, 'pins.jsonl')
}

/** @param {string} dir */
export function blockedFile (dir) {
  return join(dir, 'blocked.jsonl')
}

/** @param {string} file @returns {Promise<string[]>} the non-empty lines, or none when there is no file */
async function linesOf (file) {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim() !== '')
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
    return []
  }
}

/** @param {string} line */
function parse (line) {
  try {
    return JSON.parse(line)
  } catch {
    // A line cut short by a crash mid-append: the rest of the record still stands.
    return null
  }
}

/** @param {string} file @returns {Promise<Map<string, Pin>>} */
export async function readPins (file) {
  /** @type {Map<string, Pin>} */
  const pins = new Map()
  for (const line of await linesOf(file)) {
    const entry = parse(line)
    if (typeof entry?.cid !== 'string') continue
    const known = pins.get(entry.cid)
    if (entry.dropped === true) pins.delete(entry.cid)
    else if (entry.expired === true && entry.at === undefined) {
      if (known !== undefined) known.expired = true
    } else if (known === undefined) {
      pins.set(entry.cid, { cid: entry.cid, at: Number(entry.at) || 0, bytes: Number(entry.bytes) || 0, kubo: entry.kubo === true, filebase: entry.filebase === true, expired: entry.expired === true })
    }
  }
  return pins
}

/** One record on a line of its own, also after a line a crash cut short. @param {string} file @param {object} record */
async function append (file, record) {
  await appendFile(file, `\n${JSON.stringify(record)}\n`)
}

/** @param {string} file @param {Pin} pin */
export async function addPin (file, pin) {
  await append(file, pin)
}

/** @param {string} file @param {string} cid */
export async function markExpired (file, cid) {
  await append(file, { cid, expired: true })
}

/** @param {string} file @param {string} cid */
export async function markDropped (file, cid) {
  await append(file, { cid, dropped: true })
}

/** @param {string} file @returns {Promise<Set<string>>} the CIDs taken down */
export async function readBlocked (file) {
  const blocked = new Set()
  for (const line of await linesOf(file)) {
    const entry = parse(line)
    if (typeof entry?.cid === 'string') blocked.add(entry.cid)
  }
  return blocked
}

/** @param {string} file @param {string} cid */
export async function addBlocked (file, cid) {
  await append(file, { cid })
}

/** The pins whose month is over. @param {Map<string, Pin>} pins @param {number} now */
export function due (pins, now) {
  return [...pins.values()].filter((pin) => !pin.expired && now - pin.at >= KEEP_DAYS * DAY_MS)
}

/** Bytes kept now, and bytes taken since `since`; a copy the service did not pin anywhere is no use of its room. @param {Map<string, Pin>} pins @param {number} since */
export function usage (pins, since) {
  let live = 0
  let recent = 0
  for (const pin of pins.values()) {
    if (!pin.kubo && !pin.filebase) continue
    if (!pin.expired) live += pin.bytes
    if (pin.at >= since) recent += pin.bytes
  }
  return { live, recent }
}

/** When a pin made at `at` ends. @param {number} at */
export function endsAt (at) {
  return at + KEEP_DAYS * DAY_MS
}

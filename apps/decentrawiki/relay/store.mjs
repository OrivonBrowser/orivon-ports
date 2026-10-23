// What the free pinning relay pinned and when: JSON lines in the state directory, only ever appended,
// so the relay and the daily expiry job (expire.mjs) can write at once without losing a line. A CID's
// first pin line holds its time, size and whether the account had it before; a later `expired` line
// ends it, and a `dropped` line forgets it (a pin that failed half-way). No line names who uploaded it.

import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const KEEP_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * @typedef {{ cid: string, at: number, bytes: number, preexisting: boolean, expired: boolean }} Pin
 * `preexisting`: the CID was already pinned in the account before the relay saw it, so the relay
 * never unpins it. `expired`: its month is over and it was unpinned.
 */

/** @param {string} dir */
export function pinsFile (dir) {
  return join(dir, 'pins.jsonl')
}

/** @param {string} file @returns {Promise<Map<string, Pin>>} */
export async function readPins (file) {
  /** @type {Map<string, Pin>} */
  const pins = new Map()
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
      // A line cut short by a crash mid-append: the rest of the record still stands.
      continue
    }
    if (typeof entry?.cid !== 'string') continue
    const known = pins.get(entry.cid)
    if (entry.dropped === true) pins.delete(entry.cid)
    else if (entry.expired === true && entry.at === undefined) {
      if (known !== undefined) known.expired = true
    } else if (known === undefined) {
      pins.set(entry.cid, { cid: entry.cid, at: Number(entry.at) || 0, bytes: Number(entry.bytes) || 0, preexisting: entry.preexisting === true, expired: entry.expired === true })
    }
  }
  return pins
}

/** @param {string} file @param {Pin} pin */
export async function addPin (file, pin) {
  await appendFile(file, `${JSON.stringify(pin)}\n`)
}

/** @param {string} file @param {string} cid */
export async function markExpired (file, cid) {
  await appendFile(file, `${JSON.stringify({ cid, expired: true })}\n`)
}

/** @param {string} file @param {string} cid */
export async function markDropped (file, cid) {
  await appendFile(file, `${JSON.stringify({ cid, dropped: true })}\n`)
}

/** The pins whose month is over and that the relay may unpin. @param {Map<string, Pin>} pins @param {number} now */
export function due (pins, now) {
  return [...pins.values()].filter((pin) => !pin.expired && !pin.preexisting && now - pin.at >= KEEP_DAYS * DAY_MS)
}

/** Bytes the relay keeps pinned now, and bytes it took since `since`. @param {Map<string, Pin>} pins @param {number} since */
export function usage (pins, since) {
  let live = 0
  let recent = 0
  for (const pin of pins.values()) {
    if (pin.preexisting) continue
    if (!pin.expired) live += pin.bytes
    if (pin.at >= since) recent += pin.bytes
  }
  return { live, recent }
}

/** When a pin made at `at` ends. @param {number} at */
export function endsAt (at) {
  return at + KEEP_DAYS * DAY_MS
}

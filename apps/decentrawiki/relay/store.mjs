// What the free pinning relay pinned and when: one JSON line per CID in the state directory. The relay
// adds to it, and the daily expiry job (expire.mjs) unpins and marks what is older than KEEP_DAYS.
// No line names who uploaded it.

import { appendFile, readFile, rename, writeFile } from 'node:fs/promises'
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
    try {
      const pin = JSON.parse(line)
      if (typeof pin?.cid === 'string') pins.set(pin.cid, { cid: pin.cid, at: Number(pin.at) || 0, bytes: Number(pin.bytes) || 0, preexisting: pin.preexisting === true, expired: pin.expired === true })
    } catch {
      // A line cut short by a crash mid-append: the rest of the record still stands.
    }
  }
  return pins
}

/** @param {string} file @param {Pin} pin */
export async function addPin (file, pin) {
  await appendFile(file, `${JSON.stringify(pin)}\n`)
}

/** Rewrites the whole record at once, so a crash leaves the old one or the new one, never half of each. @param {string} file @param {Map<string, Pin>} pins */
export async function writePins (file, pins) {
  const next = `${file}.next`
  await writeFile(next, [...pins.values()].map((pin) => `${JSON.stringify(pin)}\n`).join(''))
  await rename(next, file)
}

/** The pins whose month is over and that the relay may unpin. @param {Map<string, Pin>} pins @param {number} now */
export function due (pins, now) {
  return [...pins.values()].filter((pin) => !pin.expired && !pin.preexisting && now - pin.at >= KEEP_DAYS * DAY_MS)
}

/** When a pin made at `at` ends. @param {number} at */
export function endsAt (at) {
  return at + KEEP_DAYS * DAY_MS
}

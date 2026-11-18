// What a community's published record asks a seeder to keep: the record itself, the first page of each sort and the page after
// it, the post-update files, and the pubsub topic a poster and the board's owner meet on. Read from a plain copy of the fields
// (`seeding-pkc.js` makes it), so a hostile record is only ever a few strings.

import { canonical } from '../kubo/ipfs.js'

/** More than a record needs: a record that names more is cut, so a hostile one cannot make the node pin without end. */
export const PINS_MAX = 64

/**
 * @typedef {object} SeededRecord the fields of a community's record a seeder reads
 * @property {string} [updateCid] @property {number} [updatedAt] @property {string} [pubsubTopic]
 * @property {{ pageCids?: Record<string, unknown>, pages?: Record<string, { nextCid?: unknown } | undefined> }} [posts]
 * @property {Record<string, unknown>} [postUpdates]
 */

/** @param {unknown} value @returns {string | null} the CID in the one form the node lists it in, null for text that is no CID */
function cidOf (value) {
  if (typeof value !== 'string' || value === '') return null
  try { return canonical(value) } catch { return null }
}

/** @param {unknown} value */
const entriesOf = (value) => (typeof value === 'object' && value !== null ? Object.entries(value) : [])

/**
 * @param {SeededRecord} record
 * @returns {{ pins: Array<{ cid: string, name: string }>, topic: string | null }}
 */
export function pinsOf (record) {
  /** @type {Array<{ cid: string, name: string }>} */
  const found = []
  /** @param {unknown} value @param {string} name */
  const take = (value, name) => { const cid = cidOf(value); if (cid !== null) found.push({ cid, name }) }
  take(record.updateCid, 'record')
  for (const [sort, cid] of entriesOf(record.posts?.pageCids)) take(cid, `page ${sort}`)
  for (const [sort, page] of entriesOf(record.posts?.pages)) take(/** @type {any} */ (page)?.nextCid, `next page ${sort}`)
  for (const [bucket, cid] of entriesOf(record.postUpdates)) take(cid, `post updates ${bucket}`)
  const seen = new Set()
  const pins = found.filter(({ cid }) => !seen.has(cid) && seen.add(cid)).slice(0, PINS_MAX)
  const topic = typeof record.pubsubTopic === 'string' && record.pubsubTopic !== '' && record.pubsubTopic.length <= 200 ? record.pubsubTopic : null
  return { pins, topic }
}

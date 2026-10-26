// The step after a pin: point the wiki's address at the version just published. The record is signed
// and saved first, so the publish stands whatever Orivon's node answers; sending it is a separate act
// that can be repeated, and costs nothing when the record is the same.

import { IpnsError } from '../ipfs/ipns.js'
import { getName, markKept, savedRecord, signVersion } from '../names.js'
import { PinningError } from './pinning.js'
import { keepName } from './relay-names.js'
import { FREE } from './targets.js'

/** @param {unknown} error */
function wordsOf (error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Sends the record an address holds to Orivon's node, and notes that it was kept.
 * @param {{ name: string, signal?: AbortSignal, endpoint?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ keptUntil: number }>}
 */
export async function sendSavedRecord ({ name, signal, endpoint = FREE.values.endpoint ?? '', fetchImpl }) {
  const entry = await getName(name)
  const saved = entry === undefined ? null : savedRecord(entry)
  if (saved === null) throw new PinningError('refused', 'There is no record to send yet: publish the wiki first.')
  const { keptUntil } = await keepName({
    endpoint, name, record: saved.bytes, expect: { value: saved.record.value, sequence: saved.record.sequence },
    ...(signal ? { signal } : {}), ...(fetchImpl ? { fetchImpl } : {})
  })
  await markKept(name, saved.record.sequence, keptUntil)
  return { keptUntil }
}

/**
 * Signs the record that points `name` at `cid`, and unless `send` is false hands it to Orivon's node. Never
 * throws: what went wrong comes back in words, with the sequence when the record was signed.
 * @param {{ name: string, cid: string, title: string, send: boolean, signal?: AbortSignal, endpoint?: string, fetchImpl?: typeof fetch, now?: number }} options
 * @returns {Promise<{ sequence: number | null, keptUntil: number | null, problem: string | null }>}
 */
export async function pointName ({ name, cid, title, send, signal, endpoint, fetchImpl, now }) {
  let sequence
  try {
    ({ sequence } = await signVersion(name, { cid, title, ...(now === undefined ? {} : { now }) }))
  } catch (error) {
    const said = error instanceof IpnsError ? wordsOf(error) : `The record that points the address at this version could not be signed: ${wordsOf(error)}`
    return { sequence: null, keptUntil: null, problem: said }
  }
  if (!send) return { sequence, keptUntil: null, problem: null }
  try {
    const { keptUntil } = await sendSavedRecord({ name, ...(signal ? { signal } : {}), ...(endpoint ? { endpoint } : {}), ...(fetchImpl ? { fetchImpl } : {}) })
    return { sequence, keptUntil, problem: null }
  } catch (error) {
    return { sequence, keptUntil: null, problem: wordsOf(error) }
  }
}

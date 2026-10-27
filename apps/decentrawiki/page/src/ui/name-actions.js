// What a person does with an address from more than one dialog: download its key or its public record,
// and send the saved record to Orivon's node again.

import { IPNS_RECORD_TYPE } from '../ipfs/ipns.js'
import { formatDay } from '../format.js'
import { getName } from '../names.js'
import { keyFileName, keyFileText, recordBytes, recordFileName } from '../name-files.js'
import { sendSavedRecord } from '../publish/name-step.js'
import { downloadFile, toast } from './dialog.js'

/** The entry as it is now: a retry or another tab may have changed it since a dialog drew. @param {string} name */
async function current (name) {
  const entry = await getName(name)
  if (entry === undefined) toast('This browser no longer holds the key of that address.', { kind: 'error' })
  return entry
}

/** The secret: a file whoever holds can change what the address shows. @param {string} name */
export async function downloadKey (name) {
  const entry = await current(name)
  if (entry !== undefined) downloadFile(keyFileText(entry), keyFileName(entry), 'application/json')
}

/** The newest signed record, which any IPFS node can republish. @param {string} name */
export async function downloadRecord (name) {
  const entry = await current(name)
  if (entry === undefined) return
  const bytes = recordBytes(entry)
  if (bytes === null) toast('This address has no record yet: publish the wiki first.', { kind: 'error' })
  else downloadFile(bytes, recordFileName(entry), IPNS_RECORD_TYPE)
}

/**
 * Sends the saved record to Orivon's node again, and says how it went. Resolves with whether it was kept.
 * @param {string} name @param {AbortSignal} [signal]
 */
export async function keepAgain (name, signal) {
  try {
    const { keptUntil } = await sendSavedRecord({ name, ...(signal ? { signal } : {}) })
    toast(`Orivon's node keeps the address up until ${formatDay(keptUntil)}`, { kind: 'success' })
    return true
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), { kind: 'error', timeout: 9000 })
    return false
  }
}

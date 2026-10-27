// Opening a protected share: the age file is read from where the share lives, decrypted in the crypto worker with the
// password, and its ZIP archive read and checked, entry by entry, against the description it carries.

import { decryptBlob } from '../crypto/client.js'
import { DamagedShareError } from '../crypto/age.js'
import { MAX_FILES, MAX_SHARE_BYTES } from '../lib/limits.js'
import { MANIFEST_NAME, parseManifest } from '../lib/manifest.js'
import { readZip, ZipError } from '../lib/zip.js'
import { receiveDeps } from './read.js'
import { sessionFor } from './session.js'

/**
 * @param {import('./read.js').OpenedShare} share
 * @param {string} password
 * @param {import('./read.js').ReceiveOptions} [options]
 * @returns {Promise<{ kind: 'files' | 'folder' | 'website', title: string, message: string, created: string, entries: { path: string, size: number, file: Blob }[] }>}
 */
export async function unlockShare (share, password, { signal, onProgress = () => {} } = {}) {
  const ageCid = share.cids['share.age']
  if (!share.encrypted || ageCid === undefined) throw new Error('This share is not protected by a password.')
  const session = await sessionFor(share.cid, await receiveDeps())
  const { blob } = await session.file(ageCid, {
    ...(signal ? { signal } : {}), total: share.bytes, maxBytes: Math.ceil(share.bytes * 1.05) + 64 * 1024,
    onProgress: ({ done, total, source }) => onProgress({ step: 'download', done, total, source })
  })
  const zip = await decryptBlob(blob, password.trim(), {
    ...(signal ? { signal } : {}),
    onProgress: ({ done, total }) => onProgress({ step: 'decrypt', done, total })
  })
  let files
  try {
    files = await readZip(zip, { maxBytes: MAX_SHARE_BYTES + 1024 * 1024, maxEntries: MAX_FILES + 1, ...(signal ? { signal } : {}) })
  } catch (error) {
    if (error instanceof ZipError) throw new DamagedShareError(error.message)
    throw error
  }
  const first = files[0]
  if (first === undefined || first.path !== MANIFEST_NAME) throw new DamagedShareError('its description is missing')
  const manifest = parseManifest(await first.file.text())
  const entries = files.slice(1)
  if (manifest.files !== entries.length || manifest.bytes !== entries.reduce((sum, entry) => sum + entry.size, 0)) {
    throw new DamagedShareError('its description does not match its files')
  }
  return { kind: manifest.kind, title: manifest.title, message: manifest.message, created: manifest.created, entries }
}

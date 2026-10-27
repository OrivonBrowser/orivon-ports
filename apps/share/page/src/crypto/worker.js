// The worker that runs age. The build bundles this file with typage into crypto-worker.js; scrypt at work factor
// 2^18 holds a thread for a second or more and 256 MiB of memory, which is why it is not on the page's thread.

import * as age from 'age-encryption'
import { createCipher } from './age.js'

const cipher = createCipher(age)

self.onmessage = async (/** @type {MessageEvent} */ event) => {
  const { id, op, blob, password } = event.data
  const progress = (/** @type {{ done: number, total: number }} */ p) => self.postMessage({ id, type: 'progress', ...p })
  try {
    const result = op === 'encrypt' ? await cipher.encrypt(blob, password, progress) : await cipher.decrypt(blob, password, progress)
    self.postMessage({ id, type: 'done', blob: result })
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error'
    self.postMessage({ id, type: 'error', name, message: error instanceof Error ? error.message : String(error) })
  }
}

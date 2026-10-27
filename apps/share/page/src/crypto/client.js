// The page's side of the crypto worker: one worker per call, ended when the call ends, so the memory scrypt took
// goes back at once and a cancelled call stops for certain.

import { DamagedShareError, WrongPasswordError } from './age.js'

/** Where the build puts the bundled worker, beside the page's entry. */
const WORKER_URL = new URL('../../crypto-worker.js', import.meta.url)

/**
 * @typedef {{ done: number, total: number }} Progress
 * @typedef {{ postMessage: (message: unknown) => void, terminate: () => void, onmessage: ((event: { data: any }) => void) | null, onerror: ((event: { message?: string }) => void) | null }} WorkerLike
 * @typedef {{ signal?: AbortSignal, onProgress?: (progress: Progress) => void, spawn?: () => WorkerLike }} CallOptions
 */

/** @returns {WorkerLike} */
function spawnWorker () {
  if (typeof Worker === 'undefined') throw new Error('This browser cannot run the encryption: it has no web workers.')
  return /** @type {WorkerLike} */ (/** @type {unknown} */ (new Worker(WORKER_URL)))
}

/** @param {{ name?: string, message?: string }} data */
function errorFrom (data) {
  if (data.name === 'WrongPasswordError') return new WrongPasswordError()
  if (data.name === 'DamagedShareError') return Object.assign(new DamagedShareError(''), { message: data.message ?? 'This share is damaged.' })
  return new Error(data.message ?? 'The encryption failed.')
}

/**
 * @param {'encrypt' | 'decrypt'} op @param {Blob} blob @param {string} password @param {CallOptions} options
 * @returns {Promise<Blob>}
 */
function run (op, blob, password, { signal, onProgress, spawn = spawnWorker }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Cancelled.', 'AbortError'))
      return
    }
    const worker = spawn()
    const finish = (/** @type {() => void} */ settle) => {
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
      settle()
    }
    const onAbort = () => finish(() => reject(signal?.reason ?? new DOMException('Cancelled.', 'AbortError')))
    signal?.addEventListener('abort', onAbort)
    worker.onmessage = (event) => {
      const data = event.data
      if (data.type === 'progress') onProgress?.({ done: data.done, total: data.total })
      else if (data.type === 'done') finish(() => resolve(data.blob))
      else if (data.type === 'error') finish(() => reject(errorFrom(data)))
    }
    worker.onerror = (event) => finish(() => reject(new Error(event.message ?? 'The encryption could not start.')))
    worker.postMessage({ id: 1, op, blob, password })
  })
}

/** The age file of `blob` for `password`. @param {Blob} blob @param {string} password @param {CallOptions} [options] */
export function encryptBlob (blob, password, options = {}) {
  return run('encrypt', blob, password, options)
}

/** What `password` opens in an age file. Rejects with WrongPasswordError, or DamagedShareError. @param {Blob} blob @param {string} password @param {CallOptions} [options] */
export function decryptBlob (blob, password, options = {}) {
  return run('decrypt', blob, password, options)
}

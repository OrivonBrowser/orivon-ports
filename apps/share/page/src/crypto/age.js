// Share's use of age (https://age-encryption.org/v1): a file encrypted to a passphrase, scrypt work factor 2^18,
// read and written as streams so the plaintext and the ciphertext are never both in memory. typage is handed in,
// not imported, so the same code runs in the worker (where the build bundles typage) and under test.

/** scrypt's cost: 2^18 blocks of 1 KiB, which age's own tool also uses. The ciphertext records it; a reader refuses above 2^20. */
export const SCRYPT_LOG_N = 18
/** The ciphertext and the plaintext are gathered into Blobs of about this size, which a browser may keep on disk. */
const SEGMENT_BYTES = 16 * 1024 * 1024

export class WrongPasswordError extends Error {
  constructor () {
    super('That password does not open this share.')
    this.name = 'WrongPasswordError'
  }
}

export class DamagedShareError extends Error {
  /** @param {string} detail */
  constructor (detail) {
    super(`This share is damaged and cannot be decrypted (${detail}).`)
    this.name = 'DamagedShareError'
  }
}

/**
 * @typedef {{ done: number, total: number }} Progress
 * @typedef {{ Encrypter: new () => any, Decrypter: new () => any }} Age
 */

/** @param {unknown} error */
function messageOf (error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {ReadableStream<Uint8Array>} stream @param {(bytes: number) => void} onBytes @returns {Promise<Blob>} */
async function collect (stream, onBytes) {
  /** @type {Blob[]} */
  const segments = []
  /** @type {BlobPart[]} */
  let parts = []
  let size = 0
  const reader = stream.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    parts.push(/** @type {BlobPart} */ (value))
    size += value.length
    onBytes(value.length)
    if (size >= SEGMENT_BYTES) {
      segments.push(new Blob(parts))
      parts = []
      size = 0
    }
  }
  if (parts.length > 0) segments.push(new Blob(parts))
  return new Blob(segments)
}

/** The stream, counting what passes through. @param {ReadableStream<Uint8Array>} stream @param {(bytes: number) => void} onBytes */
function counted (stream, onBytes) {
  return stream.pipeThrough(new TransformStream({
    transform (chunk, controller) {
      onBytes(chunk.length)
      controller.enqueue(chunk)
    }
  }))
}

/** @param {Age} age @param {{ logN?: number }} [options] `logN` is for tests that cannot wait for the real cost */
export function createCipher (age, { logN = SCRYPT_LOG_N } = {}) {
  return {
    /**
     * The ciphertext of `blob` for `password`.
     * @param {Blob} blob @param {string} password @param {(progress: Progress) => void} [onProgress]
     * @returns {Promise<Blob>}
     */
    async encrypt (blob, password, onProgress = () => {}) {
      const encrypter = new age.Encrypter()
      encrypter.setPassphrase(password)
      encrypter.setScryptWorkFactor(logN)
      let read = 0
      const out = await encrypter.encrypt(counted(blob.stream(), (n) => { read += n; onProgress({ done: read, total: blob.size }) }))
      return await collect(out, () => {})
    },

    /**
     * The plaintext of `blob`. A password that opens nothing throws WrongPasswordError; a file that opens and then
     * fails its checks throws DamagedShareError.
     * @param {Blob} blob @param {string} password @param {(progress: Progress) => void} [onProgress]
     * @returns {Promise<Blob>}
     */
    async decrypt (blob, password, onProgress = () => {}) {
      const decrypter = new age.Decrypter()
      decrypter.addPassphrase(password)
      /** @type {ReadableStream<Uint8Array> & { size: (n: number) => number }} */
      let out
      try {
        out = await decrypter.decrypt(blob.stream())
      } catch (error) {
        if (/no identity matched/i.test(messageOf(error))) throw new WrongPasswordError()
        throw new DamagedShareError(messageOf(error))
      }
      let total = 0
      try {
        total = out.size(blob.size)
      } catch {
        total = blob.size
      }
      let done = 0
      try {
        return await collect(out, (n) => { done += n; onProgress({ done, total }) })
      } catch (error) {
        throw new DamagedShareError(messageOf(error))
      }
    }
  }
}

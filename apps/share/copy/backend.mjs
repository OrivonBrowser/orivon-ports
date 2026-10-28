// A Kubo-compatible RPC API as the copy service uses it. Orivon's own Kubo node and the Filebase account answer
// the same three calls: does it pin a CID, import a CAR and pin its root, and unpin a CID. A CAR import is not
// read by Filebase's content filter, which refuses some files an `add` would carry. The key is sent as the
// Authorization header only, and no message or log line carries it.

import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'

const IMPORT_MS = 20 * 60_000
const CALL_MS = 60_000

/**
 * @param {{ name: string, base: string, key?: string }} options
 * @returns {{ name: string, pinned: (cid: string) => Promise<boolean>, importCar: (cid: string, file: string) => Promise<void>, unpin: (cid: string) => Promise<void> }}
 */
export function rpc ({ name, base, key = '' }) {
  const root = base.replace(/\/+$/, '')
  const authorization = key === '' ? {} : { authorization: `Bearer ${key}` }
  /** @param {string} path @param {RequestInit} [init] @param {number} [ms] */
  const call = (path, init = {}, ms = CALL_MS) => fetch(`${root}/api/v0/${path}`, { method: 'POST', headers: authorization, ...init, signal: AbortSignal.timeout(ms) })
  return {
    name,

    /** Whether `cid` is pinned recursively. Any answer but a clear one is an error, so a guess never decides who owns a pin. */
    async pinned (cid) {
      const response = await call(`pin/ls?arg=${cid}&type=recursive`)
      const text = await response.text()
      if (!response.ok) {
        if (/not pinned/i.test(text)) return false
        throw new Error(`${name} answered ${response.status} to a pin check`)
      }
      let keys
      try {
        keys = JSON.parse(text)?.Keys
      } catch {
        keys = undefined
      }
      if (typeof keys !== 'object' || keys === null) throw new Error(`${name} gave no answer to a pin check`)
      return cid in keys
    },

    /**
     * Imports the CAR in `file`, whose root is `cid`, and pins that root. The multipart body is piped from the file
     * by `node:http`: `fetch` keeps the whole body of a request in memory, so a 200 MiB copy would need 200 MiB.
     */
    async importCar (cid, file) {
      const boundary = `orivon${randomBytes(12).toString('hex')}`
      const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${cid}.car"\r\nContent-Type: application/octet-stream\r\n\r\n`)
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
      const length = head.length + (await stat(file)).size + tail.length
      const url = new URL(`${root}/api/v0/dag/import?pin-roots=true`)
      const { status, text } = await new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https : http).request(url, {
          method: 'POST',
          signal: AbortSignal.timeout(IMPORT_MS),
          headers: { ...authorization, 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': length }
        }, (response) => {
          /** @type {Buffer[]} */
          const parts = []
          response.on('data', (part) => parts.push(part))
          response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8') }))
          response.on('error', reject)
        })
        request.on('error', reject)
        request.write(head)
        const source = createReadStream(file)
        source.on('error', (error) => request.destroy(error))
        source.on('end', () => request.end(tail))
        source.pipe(request, { end: false })
      })
      if (status < 200 || status > 299) throw new Error(`${name} answered ${status} to the import`)
      const roots = text.split('\n').filter((line) => line.trim() !== '').map((line) => { try { return JSON.parse(line)?.Root } catch { return undefined } })
      const imported = roots.find((entry) => entry?.Cid?.['/'] === cid)
      if (imported === undefined) throw new Error(`${name} did not report the root of the import`)
      if (typeof imported.PinErrorMsg === 'string' && imported.PinErrorMsg !== '') throw new Error(`${name} could not pin the root: ${imported.PinErrorMsg.slice(0, 120)}`)
    },

    /** Ends the pin of `cid`; one that is already gone is fine. */
    async unpin (cid) {
      const response = await call(`pin/rm?arg=${cid}`, {}, 120_000)
      const text = await response.text()
      if (!response.ok && !/not pinned/i.test(text)) throw new Error(`${name} answered ${response.status} to an unpin`)
    }
  }
}

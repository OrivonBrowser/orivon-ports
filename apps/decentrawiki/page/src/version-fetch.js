// Fetching one version of a wiki by its IPFS address from public gateways, every block checked against the
// address, and reading what comes back as a wiki.

import { prepareImport, tiddlersFromHtml } from './import.js'
import { parseCid } from './ipfs/cid.js'
import { fetchVerified } from './ipfs/gateway.js'

/** Public gateways that answer verifiable CAR files. Each block is checked here against its CID. */
export const GATEWAYS = ['https://ipfs.orbitor.dev', 'https://ipfs.filebase.io', 'https://trustless-gateway.link']

/**
 * `ipfs://<cid>/path`, `/ipfs/<cid>`, a bare CID, or a gateway address of either form.
 * @param {string} text @returns {{ cid: string, path: string } | null}
 */
export function parseIpfsAddress (text) {
  const value = text.trim()
  /** @param {string} cid @param {string} path */
  const result = (cid, path) => {
    try {
      const clean = decodeURIComponent(path.replace(/^\/+/, '').split(/[?#]/)[0] ?? '')
      return { cid: parseCid(cid).string, path: clean === '' || clean.endsWith('/') ? `${clean}index.html` : clean }
    } catch {
      return null
    }
  }
  let match = /^ipfs:\/\/([^/?#]+)(.*)$/i.exec(value) ?? /^\/ipfs\/([^/?#]+)(.*)$/.exec(value)
  if (match) return result(match[1] ?? '', match[2] ?? '')
  if (/^[a-zA-Z0-9]{46,}$/.test(value)) return result(value, '')
  try {
    const url = new URL(value)
    match = /^([a-z0-9]+)\.ipfs\./.exec(url.hostname)
    if (match) return result(match[1] ?? '', url.pathname)
    match = /^\/ipfs\/([^/]+)(.*)$/.exec(url.pathname)
    if (match) return result(match[1] ?? '', match[2] ?? '')
  } catch {}
  return null
}

/**
 * The wiki at `cid`/`path`, fetched and read.
 * @param {string} cid @param {string} path
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} [options]
 */
export async function fetchVersion (cid, path, { fetchImpl, signal } = {}) {
  const { bytes, gateway } = await fetchVerified(cid, path, { gateways: GATEWAYS, ...(fetchImpl ? { fetchImpl } : {}), ...(signal ? { signal } : {}) })
  const tiddlers = tiddlersFromHtml(new TextDecoder().decode(bytes))
  return { tiddlers, prepared: prepareImport(tiddlers), gateway }
}

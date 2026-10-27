// The link to a share, and reading one back. A share is addressed by its CID, which sits in the fragment of a
// page address (so it never reaches a server), and a password that travels in the link sits there too, as
// `?key=` and the password's UTF-8 bytes in unpadded base64url.

import { DAG_PB, parseCid } from '../ipfs/cid.js'

/** `.eth.limo` opens in every browser; Orivon turns it into the native `.eth` name. */
export const SHARE_ORIGIN = 'https://share.orivonstack.eth.limo'

/** @param {string} text */
function toBase64Url (text) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** @param {string} text @returns {string | null} */
function fromBase64Url (text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
  } catch {
    return null
  }
}

/** @param {string} cid @param {string} [password] a password that travels in the link @returns {string} */
export function shareLink (cid, password) {
  const base = `${SHARE_ORIGIN}/#/${parseCid(cid).string}`
  return password === undefined || password === '' ? base : `${base}?key=${toBase64Url(password)}`
}

/** @param {string} text @returns {string | null} a directory's CID in base32, or null */
function directoryCid (text) {
  try {
    const cid = parseCid(text)
    return cid.codec === DAG_PB ? cid.string : null
  } catch {
    return null
  }
}

/**
 * What a person pasted: a share link from any origin, its fragment, `ipfs://<cid>`, a gateway address
 * (`https://<cid>.ipfs.dweb.link/` or `https://host/ipfs/<cid>`), or a bare CID.
 * @param {string} text
 * @returns {{ cid: string, password: string | null } | null}
 */
export function parseShareLink (text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return null
  let query = ''
  let subject = trimmed
  const hash = trimmed.indexOf('#')
  if (hash >= 0) {
    subject = trimmed.slice(hash + 1)
    const mark = subject.indexOf('?')
    if (mark >= 0) {
      query = subject.slice(mark + 1)
      subject = subject.slice(0, mark)
    }
    subject = subject.replace(/^\/+/, '')
  } else if (/^ipfs:\/\//i.test(trimmed)) {
    subject = trimmed.slice(7).split(/[/?#]/)[0] ?? ''
  } else if (/^https?:\/\//i.test(trimmed)) {
    let url
    try {
      url = new URL(trimmed)
    } catch {
      return null
    }
    const label = url.hostname.split('.')[0] ?? ''
    const inPath = /^\/ipfs\/([^/]+)/.exec(url.pathname)?.[1]
    subject = directoryCid(label) !== null && url.hostname.includes('.ipfs.') ? label : inPath ?? ''
    query = url.searchParams.has('key') ? `key=${url.searchParams.get('key') ?? ''}` : ''
  }
  const cid = directoryCid(subject.split(/[/?]/)[0] ?? '')
  if (cid === null) return null
  const key = new URLSearchParams(query).get('key')
  return { cid, password: key === null ? null : fromBase64Url(key) }
}

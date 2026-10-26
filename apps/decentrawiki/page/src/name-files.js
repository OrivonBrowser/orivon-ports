// The two files an address (an IPNS name) is kept in outside this browser: the key file, which is
// secret, and the public record. Pure. The key file is JSON that holds a Kubo key; a Kubo key file
// and Kubo's PEM are read as well.

import { IpnsError, decodeKeyFile, encodeKeyFile, nameOf, parseName } from './ipfs/ipns.js'
import { fromBase64 } from './ipfs/wire.js'
import { fileNameFor } from './format.js'

export const KEY_FILE_FORMAT = 'decentrawiki-name-key'
const MAX_KEY_FILE_CHARS = 200_000
const MAX_PUBLISHED = 2000

/** @typedef {{ cid: string, at: number, sequence: number, title: string }} NameVersion */
/** @typedef {import('./names.js').NameEntry} NameEntry */

/** @param {Uint8Array} bytes */
export function toBase64 (bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** @param {Uint8Array} bytes */
export function toHex (bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** @param {string} text @returns {Uint8Array} */
export function fromHex (text) {
  if (!/^(?:[0-9a-f]{2})+$/.test(text)) throw new RangeError('not hexadecimal')
  return Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}

/** The file name of an address's key. @param {{ label: string, name: string }} entry */
export function keyFileName (entry) {
  return `${fileNameFor(entry.label === '' ? entry.name : entry.label)}-address-key.json`
}

/** The name gateways give the record of an address. @param {{ name: string }} entry */
export function recordFileName (entry) {
  return `${entry.name}.ipns-record`
}

/** The newest signed record of an address, or null before the first publish. @param {NameEntry} entry */
export function recordBytes (entry) {
  return entry.record === null ? null : fromBase64(entry.record)
}

/** The key file of an address: its key, and every version published under it. @param {NameEntry} entry */
export function keyFileText (entry) {
  const { publicKey } = parseName(entry.name)
  const file = keyFileName(entry)
  const kubo = fileNameFor(entry.label === '' ? 'address' : entry.label)
  return JSON.stringify({
    format: KEY_FILE_FORMAT,
    version: 1,
    name: entry.name,
    address: `ipns://${entry.name}/`,
    wiki: entry.label,
    privateKey: toBase64(encodeKeyFile(fromHex(entry.seed), publicKey)),
    published: entry.history.map((version) => ({ cid: version.cid, at: new Date(version.at).toISOString(), sequence: version.sequence, title: version.title })),
    note: `Keep this file secret: whoever holds it can change what this address shows. Import it in the DecentraWiki editor, or into Kubo with: jq -r .privateKey ${file} | base64 -d > ${entry.name}.key && ipfs key import ${kubo} ${entry.name}.key`
  }, null, 2)
}

/** @param {unknown} list @returns {NameVersion[]} */
function versionsOf (list) {
  if (!Array.isArray(list)) return []
  /** @type {NameVersion[]} */
  const versions = []
  for (const item of list.slice(0, MAX_PUBLISHED)) {
    const at = typeof item?.at === 'number' ? item.at : Date.parse(String(item?.at))
    if (typeof item?.cid !== 'string' || !/^b[a-z2-7]{20,}$/.test(item.cid) || !Number.isFinite(at)) continue
    if (!Number.isSafeInteger(item.sequence) || item.sequence < 0) continue
    versions.push({ cid: item.cid, at, sequence: item.sequence, title: typeof item.title === 'string' ? item.title.slice(0, 200) : '' })
  }
  return versions
}

/**
 * A key file of either kind: ours (JSON), Kubo's own key file, or Kubo's PEM.
 * @param {Uint8Array} bytes
 * @returns {Promise<{ seed: Uint8Array, publicKey: Uint8Array, name: string, label: string, history: NameVersion[] }>}
 */
export async function readKeyFile (bytes) {
  const start = bytes.findIndex((byte) => byte !== 0x20 && byte !== 0x0a && byte !== 0x0d && byte !== 0x09)
  if (bytes[start] !== 0x7b) {
    const { seed, publicKey } = await decodeKeyFile(bytes)
    return { seed, publicKey, name: nameOf(publicKey), label: '', history: [] }
  }
  const notOurs = () => new IpnsError('malformed', 'This is not a DecentraWiki address key: it is a JSON file of another kind.')
  let parsed
  try {
    if (bytes.length > MAX_KEY_FILE_CHARS) throw new Error('too large')
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw notOurs()
  }
  if (parsed?.format !== KEY_FILE_FORMAT || parsed.version !== 1 || typeof parsed.privateKey !== 'string') throw notOurs()
  let keyBytes
  try {
    keyBytes = fromBase64(parsed.privateKey)
  } catch {
    throw new IpnsError('malformed', 'This address key file is damaged: its private key cannot be read.')
  }
  const { seed, publicKey } = await decodeKeyFile(keyBytes)
  const name = nameOf(publicKey)
  if (typeof parsed.name === 'string' && parsed.name !== name) {
    throw new IpnsError('mismatch', 'This address key file is damaged: the address it names does not belong to its private key.')
  }
  return { seed, publicKey, name, label: typeof parsed.wiki === 'string' ? parsed.wiki.slice(0, 120) : '', history: versionsOf(parsed.published) }
}

/** Whether a file is an address key by its name or its first bytes, so a wiki file never reads as one. @param {string} fileName @param {Uint8Array} head */
export function looksLikeKey (fileName, head) {
  if (/\.(?:key|pem)$/i.test(fileName)) return true
  const text = new TextDecoder().decode(head)
  return text.startsWith('-----BEGIN') || (/^\s*\{/.test(text) && text.includes(KEY_FILE_FORMAT))
}

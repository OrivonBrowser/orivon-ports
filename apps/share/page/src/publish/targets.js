// Services that can also keep a share online while Share is closed: a pinning service or IPFS node the person
// holds, configured once and kept in this browser. Each takes the share as an upload and must report the address
// computed here. Where a share is kept first, on this computer, and served from there, is keep/ and serve/.

import { PinningError, kuboAdd, kuboVersion, pinataTest, pinataUpload } from './pinning.js'

/**
 * @typedef {{ name: string, label: string, placeholder?: string, value?: string, secret?: boolean, optional?: boolean }} Field
 * @typedef {{ id: string, kind: 'kubo' | 'filebase' | 'pinata' | 'rpc', values: Record<string, string> }} Target
 */

export const TARGET_KINDS = {
  kubo: {
    label: 'IPFS Desktop or Kubo',
    blurb: 'A node of yours, on this computer or on a server. The share goes straight to your node and to nobody else.',
    fields: /** @type {Field[]} */ ([{ name: 'endpoint', label: 'Node API address', placeholder: 'http://127.0.0.1:5001', value: 'http://127.0.0.1:5001' }]),
    link: { href: 'https://docs.ipfs.tech/install/ipfs-desktop/', text: 'Get IPFS Desktop' }
  },
  filebase: {
    label: 'Filebase',
    blurb: 'A pinning service. Use an IPFS RPC API key from your Filebase account; the share is pinned in the bucket that key belongs to.',
    fields: /** @type {Field[]} */ ([{ name: 'key', label: 'IPFS RPC API key', secret: true }]),
    link: { href: 'https://console.filebase.com/keys', text: 'Filebase access keys' }
  },
  pinata: {
    label: 'Pinata',
    blurb: 'A pinning service. Create an API key in your Pinata account and paste its JWT here.',
    fields: /** @type {Field[]} */ ([{ name: 'jwt', label: 'API key (JWT)', secret: true }]),
    link: { href: 'https://app.pinata.cloud/developers/api-keys', text: 'Pinata API keys' }
  },
  rpc: {
    label: 'Another IPFS service',
    blurb: 'Any node or service that answers the Kubo RPC API, such as a node of yours behind HTTPS.',
    fields: /** @type {Field[]} */ ([
      { name: 'endpoint', label: 'RPC API address', placeholder: 'https://ipfs.example.org' },
      { name: 'authorization', label: 'Authorization header', placeholder: 'Bearer …', secret: true, optional: true }
    ]),
    link: null
  }
}

/** What a person reads for a target. @param {Target} target */
export function describe (target) {
  const kind = TARGET_KINDS[target.kind]
  if (target.kind === 'kubo' || target.kind === 'rpc') {
    try {
      return `${kind.label} (${new URL(target.values.endpoint ?? '').host})`
    } catch {
      return kind.label
    }
  }
  return kind.label
}

/** @param {Target} target */
function kuboOptions (target) {
  if (target.kind === 'filebase') return { endpoint: 'https://rpc.filebase.io', authorization: `Bearer ${target.values.key ?? ''}` }
  const authorization = (target.values.authorization ?? '').trim()
  return { endpoint: target.values.endpoint ?? '', ...(authorization === '' ? {} : { authorization }) }
}

/**
 * Uploads a share's files to a service and resolves with the root CID the service reports.
 * @param {Target} target
 * @param {{ name: string, files: { path: string, blob: Blob }[], signal?: AbortSignal }} upload
 * @returns {Promise<{ cid: string }>}
 */
export async function pin (target, { name, files, signal }) {
  if (target.kind === 'pinata') return await pinataUpload({ jwt: target.values.jwt ?? '', rootName: 'share', name, files, ...(signal ? { signal } : {}) })
  const { cid } = await kuboAdd({ ...kuboOptions(target), rootName: 'share', files, ...(signal ? { signal } : {}) })
  return { cid }
}

/**
 * Filebase answers `version` whatever the key; asking whether it pins the empty
 * address (`bafkqaaa`, which nobody pins) needs a key it knows.
 * @param {string} key @param {AbortSignal} [signal]
 */
async function checkFilebase (key, signal) {
  let response
  try {
    response = await fetch('https://rpc.filebase.io/api/v0/pin/ls?arg=bafkqaaa&type=recursive', { method: 'POST', headers: { authorization: `Bearer ${key}` }, ...(signal ? { signal } : {}) })
  } catch {
    throw new PinningError('unreachable', 'Could not reach Filebase. Check your connection and try again.')
  }
  if (response.status === 401 || response.status === 403) throw new PinningError('unauthorized', 'Filebase refused the key: check it and try again.')
  if (!response.ok) throw new PinningError('refused', `Filebase answered the check with status ${response.status}.`)
}

/** Checks the target answers and accepts its credentials. @param {Target} target @param {AbortSignal} [signal] */
export async function check (target, signal) {
  if (target.kind === 'pinata') await pinataTest({ jwt: target.values.jwt ?? '', ...(signal ? { signal } : {}) })
  else if (target.kind === 'filebase') await checkFilebase(target.values.key ?? '', signal)
  else await kuboVersion({ ...kuboOptions(target), ...(signal ? { signal } : {}) })
}

/** The commands that let the page reach a person's own node. @param {string} origin */
export function nodeSetupCommands (origin) {
  return [
    `ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["${origin}"]'`,
    'ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods \'["POST"]\''
  ]
}

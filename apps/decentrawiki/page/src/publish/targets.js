// Where a wiki can be pinned: the person's own IPFS node, or a pinning service
// they hold an account with. Each is configured once and kept in this browser.
// The editor runs no pinning service of its own.

import * as store from '../store.js'
import { PinningError, kuboAdd, kuboVersion, pinataTest, pinataUpload } from './pinning.js'

/**
 * @typedef {{ name: string, label: string, placeholder?: string, value?: string, secret?: boolean, optional?: boolean }} Field
 * @typedef {{ id: string, kind: keyof typeof KINDS, values: Record<string, string> }} Target
 */

export const KINDS = {
  kubo: {
    label: 'Your IPFS node',
    blurb: 'IPFS Desktop or Kubo, on this computer or on a server of yours. The wiki goes straight to your node and to nobody else.',
    fields: /** @type {Field[]} */ ([{ name: 'endpoint', label: 'Node API address', placeholder: 'http://127.0.0.1:5001', value: 'http://127.0.0.1:5001' }]),
    link: { href: 'https://docs.ipfs.tech/install/ipfs-desktop/', text: 'Get IPFS Desktop' }
  },
  filebase: {
    label: 'Filebase',
    blurb: 'A pinning service. Use an IPFS RPC API key from your Filebase account; the wiki is pinned in the bucket that key belongs to.',
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

/** @returns {Promise<Target[]>} */
export async function loadTargets () {
  const saved = await store.getSetting('targets', /** @type {Target[]} */ ([]))
  return saved.filter((target) => target && target.kind in KINDS)
}

/** @param {Target[]} targets */
export async function saveTargets (targets) {
  await store.setSetting('targets', targets)
}

/** @returns {Promise<string | null>} */
export async function defaultTargetId () {
  return await store.getSetting('defaultTarget', null)
}

/** @param {string | null} id */
export async function setDefaultTarget (id) {
  await store.setSetting('defaultTarget', id)
}

/** What a person reads for a target. @param {Target} target */
export function describe (target) {
  const kind = KINDS[target.kind]
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
 * Pins a directory. Resolves with the root CID the target reports.
 * @param {Target} target
 * @param {{ rootName: string, name: string, files: { path: string, bytes: Uint8Array }[], signal?: AbortSignal }} upload
 * @returns {Promise<string>}
 */
export async function pin (target, { rootName, name, files, signal }) {
  if (target.kind === 'pinata') return (await pinataUpload({ jwt: target.values.jwt ?? '', rootName, name, files, ...(signal ? { signal } : {}) })).cid
  return (await kuboAdd({ ...kuboOptions(target), rootName, files, ...(signal ? { signal } : {}) })).cid
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

/** The commands that let the editor reach a person's own node. @param {string} origin */
export function nodeSetupCommands (origin) {
  return [
    `ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["${origin}"]'`,
    'ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods \'["POST"]\''
  ]
}

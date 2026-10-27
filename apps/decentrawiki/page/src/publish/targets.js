// Where a wiki can be pinned: a pinning service or IPFS node the person holds,
// configured once and kept in this browser, or Orivon's free pinning, which keeps
// each version for FREE_DAYS. In Orivon free pinning takes the wiki from the IPFS
// node this page runs (page-node.js), unless Settings chose the upload; elsewhere
// it takes it as an upload.

import * as store from '../store.js'
import { pageNodeAvailable, publishFromPageNode } from './page-node.js'
import { PinningError, kuboAdd, kuboVersion, pinataTest, pinataUpload } from './pinning.js'

/**
 * @typedef {{ name: string, label: string, placeholder?: string, value?: string, secret?: boolean, optional?: boolean }} Field
 * @typedef {{ id: string, kind: keyof typeof KINDS | 'free', values: Record<string, string> }} Target
 */

/** How long Orivon's free pinning keeps a version, once per address. */
export const FREE_DAYS = 30

/**
 * Orivon's free pinning: a Kubo-compatible relay that takes published DecentraWiki wikis only and pins each
 * version on Orivon's Filebase account for FREE_DAYS. Like any target, its answer must name the address
 * computed here, so it can fail a publish but never change a wiki.
 * @type {Target}
 */
export const FREE = { id: 'free', kind: 'free', values: { endpoint: 'https://telemetry.orivonstack.com/decentrawiki' } }

/** The day a version pinned for free at `at` stops being kept. @param {number} at */
export function freeUntil (at) {
  return at + FREE_DAYS * 24 * 60 * 60 * 1000
}

export const KINDS = {
  kubo: {
    label: 'IPFS Desktop or Kubo',
    blurb: 'A node of yours, on this computer or on a server. The wiki goes straight to your node and to nobody else.',
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

/** What a person reads for a target. `fromNode`: free pinning publishes from the page's node. @param {Target} target @param {boolean} [fromNode] */
export function describe (target, fromNode = false) {
  if (target.kind === 'free') return fromNode ? 'Your IPFS node, in this page' : 'Free pinning by Orivon'
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

/** How a publication with `target` is recorded, given the time it is kept until. @param {Target} target @param {number | null} until @param {boolean} [fromNode] */
export function recordName (target, until, fromNode = false) {
  if (until === null) return describe(target, fromNode)
  const day = new Date(until).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  return target.kind === 'free' && fromNode ? `Your IPFS node, kept by Orivon until ${day}` : `${describe(target, fromNode)}, until ${day}`
}

/** @param {Target} target */
function kuboOptions (target) {
  if (target.kind === 'filebase') return { endpoint: 'https://rpc.filebase.io', authorization: `Bearer ${target.values.key ?? ''}` }
  const authorization = (target.values.authorization ?? '').trim()
  return { endpoint: target.values.endpoint ?? '', ...(authorization === '' ? {} : { authorization }) }
}

/**
 * Pins a directory. Resolves with the root CID the target reports, and for free pinning the time it
 * says it keeps the directory until. `site` is the directory as this page addressed it, which free
 * pinning publishes from the page's own node when `fromNode` is set; otherwise it is uploaded.
 * @param {Target} target
 * @param {{ rootName: string, name: string, files: { path: string, bytes: Uint8Array }[], site?: { cid: string, car: () => Uint8Array }, fromNode?: boolean, signal?: AbortSignal, onStep?: (text: string) => void }} upload
 * @returns {Promise<{ cid: string, keptUntil: number | null }>}
 */
export async function pin (target, { rootName, name, files, site, fromNode = false, signal, onStep }) {
  if (target.kind === 'free' && fromNode && site !== undefined && pageNodeAvailable()) {
    const { cid, keptUntil } = await publishFromPageNode({ endpoint: target.values.endpoint ?? '', cid: site.cid, car: site.car(), ...(signal ? { signal } : {}), ...(onStep ? { onStep } : {}) })
    return { cid, keptUntil: keptUntil ?? freeUntil(Date.now()) }
  }
  if (target.kind === 'pinata') return { cid: (await pinataUpload({ jwt: target.values.jwt ?? '', rootName, name, files, ...(signal ? { signal } : {}) })).cid, keptUntil: null }
  const { cid, keptUntil } = await kuboAdd({ ...kuboOptions(target), rootName, files, ...(signal ? { signal } : {}) })
  return { cid, keptUntil: target.kind === 'free' ? keptUntil ?? freeUntil(Date.now()) : null }
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

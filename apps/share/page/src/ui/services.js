// The services a share can also be kept with, so that it stays online when Share is closed: IPFS Desktop
// or Kubo, Filebase, Pinata, or another Kubo-compatible service. They are the person's own; this file keeps
// their settings and words them.

import * as engine from '../engine.js'
import { hostOf } from '../format.js'
import * as store from '../store.js'

/** @typedef {import('../engine.js').Target} Service */

/** The services the person added, in the order they were added. @returns {Promise<Service[]>} */
export async function loadServices () {
  const saved = await store.getSetting('targets', /** @type {Service[]} */ ([]))
  return saved.filter((service) => service && service.kind in engine.TARGET_KINDS)
}

/** @param {Service[]} services */
export async function saveServices (services) {
  await store.setSetting('targets', services)
}

/** @returns {Promise<string | null>} the id of the service a new share is also kept with, or null for none */
export async function defaultServiceId () {
  const id = await store.getSetting('defaultTarget', /** @type {string | null} */ (null))
  return id !== null && (await loadServices()).some((service) => service.id === id) ? id : null
}

/** @param {string | null} id */
export async function setDefaultService (id) {
  await store.setSetting('defaultTarget', id)
}

/** What a person reads for a service. @param {Service} service */
export function describeService (service) {
  const label = engine.TARGET_KINDS[service.kind]?.label ?? service.kind
  return service.kind === 'kubo' || service.kind === 'rpc' ? `${label} (${hostOf(service.values.endpoint ?? '')})` : label
}

/** One sentence on what keeping a share with `service` means. @param {Service} service */
export function describeKeeping (service) {
  return service.kind === 'kubo'
    ? 'Goes straight to your own IPFS node and nowhere else. Kept for as long as the node keeps it.'
    : 'Kept under the account or service you set up, for as long as it keeps it.'
}

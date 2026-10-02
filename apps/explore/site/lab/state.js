// What a probe can do right now. Pure: given a probe and what the page knows about Orivon.

import { contains } from './declarations.js'

/**
 * @typedef {'not in Orivon' | 'not declared' | 'declared, not granted' | 'granted' | 'ready'} ProbeState
 */

/**
 * `ready` is a probe that needs no capability: it can run wherever Orivon is. Otherwise a
 * probe is declared when the manifest holds everything it `declares`, and granted when a
 * grant names its capability.
 * @param {{ capability: string | null, declares: Record<string, any> }} probe
 * @param {import('../orivon.js').Snapshot} snapshot
 * @returns {ProbeState}
 */
export function probeState (probe, snapshot) {
  if (!snapshot.inOrivon) return 'not in Orivon'
  if (probe.capability === null) return 'ready'
  if (!snapshot.manifest || !contains(snapshot.manifest.capabilities, probe.declares)) return 'not declared'
  return snapshot.grants.some((grant) => grant.capability === probe.capability) ? 'granted' : 'declared, not granted'
}

/** @param {ProbeState} state */
export function canRun (state) {
  return state === 'ready' || state === 'granted'
}

/** @param {ProbeState} state */
export function canRequest (state) {
  return state === 'declared, not granted'
}

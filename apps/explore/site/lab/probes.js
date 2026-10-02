// Every probe the Lab can run. A static list: the manifest test merges each probe's
// `declares` and compares it with orivon.json, so adding a probe means adding it here.

import manifestRoundtrip from './probes/manifest-roundtrip.js'
import grantsWithinManifest from './probes/grants-within-manifest.js'

/**
 * @typedef {{ ok: boolean, detail: string }} ProbeResult
 * @typedef {{
 *   orivon: import('../orivon.js').OrivonApi,
 *   served: { manifest(): Promise<import('../orivon.js').Manifest> }
 * }} ProbeContext
 * @typedef {{
 *   id: string, title: string, capability: string | null, declares: Record<string, any>,
 *   run(context: ProbeContext): Promise<ProbeResult>
 * }} Probe
 */

/** @type {readonly Probe[]} */
export const PROBES = [manifestRoundtrip, grantsWithinManifest]

// What a page of this app may ask of the node about how it is reached, over the gateway's socket: the node's `reach` with what it
// rests on, the circuits it gives out, the puts in flight, the bandwidth and the relay the person named; and naming or removing that
// relay (which starts the node again, its data kept). Same door as the board manager's (manager-api.js).

import { errorResponse, jsonResponse, KuboError } from '../kubo/wire.js'
import { ConfigError } from './board-config.js'
import { relayPeer } from './reachability.js'
import { bodyOf } from './manager-api.js'
import { UnsupportedError } from './relay-setting.js'
import { sameKey } from './rpc-guard.js'

/** Where the socket answers them: `POST /orivon/reach/<call>`. */
export const REACH_API_PATH = '/orivon/reach/'

/** The calls, and only these. */
export const REACH_CALLS = Object.freeze(['state', 'relay/set', 'relay/remove'])

/** @param {unknown} error */
function asKuboError (error) {
  if (error instanceof KuboError) return error
  if (error instanceof ConfigError) return new KuboError(error.message, { status: 400 })
  if (error instanceof UnsupportedError) return new KuboError(error.message, { status: 409 })
  return error
}

/** A circuit address as `{ relay, peer }`: the relay's own address and its peer id. @param {string} circuit */
function circuitOf (circuit) {
  const relay = circuit.split('/p2p-circuit')[0] ?? circuit
  return { relay, peer: relayPeer(relay) }
}

/**
 * What the page is shown of how the node is reached.
 * @param {{
 *   status: import('./status-feed.js').NodeStatus | null, bandwidth: import('./bandwidth.js').Bandwidth | null,
 *   relay: { relay: string | undefined, source: 'saved' | 'page' | 'none' }, supported: boolean, node: string
 * }} facts `status` is null when the node did not answer; `node` is the supervisor's last word (`starting`, `up`, `restarting`, `failed`)
 */
export function describeReach ({ status, bandwidth, relay, supported, node }) {
  const named = relayPeer(relay.relay)
  const circuits = (status?.circuits ?? []).map(circuitOf).map((one) => ({ ...one, named: named !== null && one.peer === named }))
  return {
    node, answered: status !== null,
    reachability: status?.reachability ?? 'unknown', reason: status?.basis ?? null, source: status?.source ?? null,
    autonat: status?.autonat ?? 'unknown', punch: status?.punch ?? null, peers: status?.peers ?? null, external: status?.external.length ?? 0,
    circuits, puts: status?.puts ?? null,
    bandwidth: bandwidth === null ? null : { totalIn: bandwidth.TotalIn, totalOut: bandwidth.TotalOut, rateIn: bandwidth.RateIn, rateOut: bandwidth.RateOut },
    relay: { address: relay.relay ?? null, peer: named, source: relay.source, supported, holds: named !== null && circuits.some((one) => one.named) }
  }
}

/**
 * @param {{
 *   authKey: string,
 *   network: { state: () => Promise<ReturnType<typeof describeReach>>, setRelay: (address: unknown) => Promise<unknown>, removeRelay: () => Promise<unknown> } | null
 * }} options `network` is null for a Worker that cannot read its node, which answers that it has none
 */
export function reachApi ({ authKey, network }) {
  return {
    /** @param {Request} request */
    async handle (request) {
      try {
        const url = new URL(request.url)
        if (request.method !== 'POST') return errorResponse(new KuboError('only POST allowed', { status: 405 }))
        if (!sameKey(request.headers.get('authorization') ?? '', `Bearer ${authKey}`)) return errorResponse(new KuboError('missing or wrong key', { status: 401 }))
        const call = url.pathname.slice(REACH_API_PATH.length).replace(/\/+$/, '')
        if (!REACH_CALLS.includes(call)) return errorResponse(new KuboError(`${call} is not a call a page may make`, { status: 403 }))
        if (network === null) return errorResponse(new KuboError('this build of the node cannot report how it is reached', { status: 503 }))
        const body = await bodyOf(request)
        if (call === 'relay/set') await network.setRelay(body['relay'])
        else if (call === 'relay/remove') await network.removeRelay()
        return jsonResponse(await network.state())
      } catch (error) {
        return errorResponse(asKuboError(error))
      }
    }
  }
}

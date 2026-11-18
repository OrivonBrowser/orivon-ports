// The bytes the node has sent and received, for the page API's `stats/bw`. Orivon's IPFS node counts the wire bytes of its
// TCP sockets and answers them at `GET /orivon/stats/bw` in Kubo's field names, and its `/health` names `bandwidth` in
// `x-orivon-node-features` when it can. A component built before that has no route, and then the page is told nothing: a
// total that is absent reads as unknown, where a zero would read as a measurement.

const FIELDS = /** @type {const} */ (['TotalIn', 'TotalOut', 'RateIn', 'RateOut'])

/** @typedef {{ TotalIn: number | null, TotalOut: number | null, RateIn: number | null, RateOut: number | null }} Bandwidth */

/** The answer for a node that gives no counts. @returns {Bandwidth} */
export const noBandwidth = () => ({ TotalIn: null, TotalOut: null, RateIn: null, RateOut: null })

/** @param {unknown} value @returns {number | null} */
const figure = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)

/**
 * Reads the node's counts when it has them: its features are read once they have been read, the route at every call.
 * @param {{ fetch: typeof fetch, base: string, key: string }} node `fetch` is the process's own, never the facade's
 * @returns {() => Promise<Bandwidth | null>} null when the node does not count, does not answer or answers something else
 */
export function bandwidthReader ({ fetch: ask, base, key }) {
  const headers = { 'x-orivon-key': key }
  /** @type {boolean | null} null until a node has answered `/health` */
  let counts = null
  return async () => {
    try {
      if (counts === null) {
        const health = await ask(`${base}/health`, { headers, signal: AbortSignal.timeout(5_000) })
        counts = (health.headers.get('x-orivon-node-features') ?? '').split(',').includes('bandwidth')
      }
      if (!counts) return null
      const answer = await ask(`${base}/orivon/stats/bw`, { headers, signal: AbortSignal.timeout(5_000) })
      if (!answer.ok) return null
      const body = /** @type {Record<string, unknown> | null} */ (await answer.json())
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
      return { ...noBandwidth(), ...Object.fromEntries(FIELDS.map((field) => [field, figure(body[field])])) }
    } catch { return null }
  }
}

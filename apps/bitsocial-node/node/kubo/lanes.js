// Which of the Worker's calls to the node's API may wait for a connection, and which must not.
//
// The Worker is a web worker, and its engine lets one page hold six connections to one host and port. The node's API is one host and port, so every call the
// facade makes shares those six. A read of someone else's content (a block, a file, a name) holds its connection for as long as the node waits on the network
// for it, which is up to about twenty seconds for content nobody serves, and seedit asks for a dozen at once as it opens its default communities. With six
// of those out, a community's key import, which its first signed record waits for, queues behind them until the first gives up.
//
// So the reads that wait on the network (the "slow" lane) take at most `total - reserved` of the six, less one for each stream the Worker holds open (a
// pubsub subscription keeps its connection for as long as it lives), and never fewer than one; everything else (keys, publishing, pins, provides, a block put)
// is never made to wait here. A read of the record of a name whose key the node holds is outside the lane too: the node answers it from its own store, so it
// never waits on the network, and it is the read a community's page makes first. Only the Worker's own calls are counted: the engine's pool is not visible from inside.
//
// They are for a Worker that calls the node with the engine's `fetch` (`BITSOCIAL_NODE_FETCH=fetch`). Called over `http` (`http-fetch.js`) there is no pool, the node serves
// 64 requests at once (`NODE_REQUESTS`), and the lanes only hurt: a read of a block the node holds (a community's own record, which a page's first read follows the name
// with) queued behind the slow reads for up to 20 s. The Worker gives them no limit there; `BITSOCIAL_SLOW_CALLS=share` brings the share back for a measurement.

/**
 * @typedef {object} LaneOptions
 * @property {number} [total] connections the engine gives one host and port
 * @property {number} [reserved] of them, kept from the slow lane for the other calls
 * @property {number} [slowMax] a fixed number of slow calls at once, in place of the share of `total`; 0 puts no limit on them
 */

/** The calls that wait on the network for content, as the node client names them: its path and, for a gateway read, the path's first segment. */
const SLOW = /^\/(?:orivon\/(?:cat|resolve|ls|name\/resolve)\/|ipfs\/|ipns\/)/

/** A read of one name's record: the gateway's `/ipns/<name>` or the node's `/orivon/name/resolve/<name>`, with nothing below the name. */
const NAME_READ = /^\/(?:ipns|orivon\/name\/resolve)\/([^/?#]+)(?:[?#].*)?$/

/**
 * @param {string} path the node API path of a call, without its query
 * @param {(name: string) => boolean} [holds] whether the node holds the key of a name: the record of such a name is on the node, so reading it waits for nothing
 * @returns {'slow' | 'held' | 'control'}
 */
export function laneOf (path, holds = () => false) {
  if (path === '/pubsub/sub') return 'held'
  if (!SLOW.test(path)) return 'control'
  const name = NAME_READ.exec(path)?.[1]
  return name !== undefined && holds(name) ? 'control' : 'slow'
}

/** @param {LaneOptions} [options] */
export function createLanes (options = {}) {
  const { total = 6, reserved = 2, slowMax } = options
  let held = 0
  let running = 0
  /** @type {Array<{ start: () => void, drop: () => void }>} */
  const queue = []

  const cap = () => (slowMax === undefined ? Math.max(1, total - reserved - held) : slowMax)

  function pump () {
    const limit = cap()
    while (queue.length > 0 && (limit === 0 || running < limit)) queue.shift()?.start()
  }

  return {
    /**
     * Runs `call` once there is room in the slow lane; the place is given back when `call` answers (the node sends a read's headers once it has the content, so the
     * wait is over by then) or fails. A call whose signal aborts while it waits is dropped and never starts.
     * @template T @param {() => Promise<T>} call @param {AbortSignal} [signal] @returns {Promise<T>}
     */
    slow (call, signal) {
      if (signal?.aborted === true) return Promise.reject(signal.reason ?? new DOMException('aborted', 'AbortError'))
      return new Promise((resolve, reject) => {
        /** @type {() => void} */
        let forget = () => {}
        const entry = {
          start: () => {
            forget()
            running += 1
            const release = () => { running -= 1; pump() }
            Promise.resolve().then(call).then((value) => { release(); resolve(value) }, (error) => { release(); reject(error) })
          },
          drop: () => { reject(signal?.reason ?? new DOMException('aborted', 'AbortError')) }
        }
        if (signal !== undefined) {
          const onAbort = () => {
            const at = queue.indexOf(entry)
            if (at >= 0) { queue.splice(at, 1); entry.drop() }
          }
          signal.addEventListener('abort', onAbort, { once: true })
          forget = () => { signal.removeEventListener('abort', onAbort) }
        }
        queue.push(entry)
        pump()
      })
    },

    /** Counts a stream held open, and returns the call that lets it go (once). @returns {() => void} */
    hold () {
      held += 1
      let released = false
      return () => {
        if (released) return
        released = true
        held -= 1
        pump()
      }
    },

    snapshot () { return { slowRunning: running, slowQueued: queue.length, held, cap: cap() } }
  }
}

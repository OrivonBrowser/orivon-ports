// orivon:comment-budget -- the JSDoc types below are the contract the core and the interface are written against
// The one contract between TorSocks' core (src/core/: the daemon, the files,
// what a publication turns into) and its interface (src/ui/). The core holds
// the state below and calls every subscriber after each change; the interface
// reads the state and calls the actions, and touches nothing else.

/**
 * @typedef {'checking' | 'starting' | 'running' | 'failed' | 'outside-orivon'} DaemonPhase
 *   checking: looking for a daemon this app already runs; starting: spawning one;
 *   running: connected to it; failed: it stopped or could not start (see `error`);
 *   outside-orivon: the page is not in Orivon, so nothing can run.
 *
 * @typedef {object} Bootstrap
 * @property {number} frac      0..1, Arti's own estimate.
 * @property {boolean} ready    Tor is reachable: the proxy carries traffic.
 * @property {string} msg       Arti's words for the step it is on.
 * @property {string | null} blocked  Why it is stuck, when it is.
 *
 * @typedef {object} Socks
 * @property {'waiting' | 'listening' | 'failed'} state
 * @property {string} host      Always 127.0.0.1 when listening.
 * @property {number} port
 * @property {string} msg       Why it failed, when it did.
 *
 * @typedef {'article' | 'picture' | 'file' | 'folder' | 'website'} Kind
 *
 * @typedef {'off' | 'starting' | 'publishing' | 'running' | 'degraded' | 'unreachable' | 'recovering' | 'broken' | 'stopped'} ServiceState
 *   off: the person switched it off; the rest are the daemon's words for a service it runs.
 *
 * @typedef {object} Check
 * @property {boolean} pending
 * @property {boolean} ok
 * @property {string} text      What answered, or why nothing did.
 * @property {number} ms
 * @property {number} at        ms since the epoch: when the test began (pending) or its answer came.
 * @property {boolean} auto     The page ran it by itself, not the person (core/reach.js).
 *
 * @typedef {object} Service
 * @property {string} id
 * @property {Kind} kind
 * @property {string} title
 * @property {string} created   ISO date.
 * @property {boolean} enabled  The person wants it online.
 * @property {string | null} onion  `<56 chars>.onion`, known once it was first started.
 * @property {ServiceState} state
 * @property {string | null} problem
 * @property {number} hits      Connections served since the daemon started.
 * @property {number} bytes     What the publication holds on disk.
 * @property {number} files
 * @property {Check | null} check
 * @property {boolean} reached  A test through Tor passed recently while Arti's own state had not settled:
 *   the service answers, whatever `state` says.
 * @property {number | null} waitingSince  ms since the epoch: when the page began waiting for Arti to settle.
 * @property {number | null} passedAt      ms since the epoch: when a test last passed.
 *
 * @typedef {object} LogLine
 * @property {number} time      ms since the epoch, when the page received it.
 * @property {'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE'} level
 * @property {string} target
 * @property {string} msg
 *
 * @typedef {object} Progress
 * @property {string} label
 * @property {number} done
 * @property {number} total
 *
 * @typedef {object} State
 * @property {DaemonPhase} phase
 * @property {string | null} error
 * @property {Bootstrap} bootstrap
 * @property {Socks} socks
 * @property {{ open: number, total: number }} traffic
 * @property {Service[]} services   Newest first.
 * @property {LogLine[]} logs       Oldest first, at most 400.
 * @property {Progress | null} busy  A publication being written, or null.
 * @property {string} arti           The Arti release inside, such as "0.47.0".
 */

/**
 * @typedef {object} Actions
 * @property {(input: { title: string, body: string, byline: string }) => Promise<string>} publishArticle
 *   Writes the article as a page and publishes it; resolves with the new id.
 * @property {(input: { kind: 'picture' | 'file' | 'folder' | 'website', title: string, files: File[], note?: string }) => Promise<string>} publishFiles
 *   `files` keep their `webkitRelativePath` for a folder or a website. Rejects with an
 *   Error whose message is meant for the person (a website without index.html, too large).
 * @property {(id: string, enabled: boolean) => Promise<void>} setEnabled
 * @property {(id: string) => Promise<void>} remove   Deletes the files and the key: the address is gone for good.
 * @property {(id: string, options?: { auto?: boolean }) => void} check
 *   Reaches the service through Tor and reports what answered; `auto` marks a test the page runs by itself.
 * @property {() => Promise<void>} restart            Stops the daemon and starts it again.
 * @property {(id: string) => string} visitUrl        `http://<onion>/`, or '' before it has an address.
 */

/**
 * Limits the interface states and the core enforces.
 * @type {Readonly<{ maxBytes: number, maxFiles: number, titleLength: number, articleLength: number }>}
 */
export const LIMITS = Object.freeze({
  /** One publication, all its files together. */
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxFiles: 5000,
  titleLength: 120,
  articleLength: 200_000
})

export const KINDS = Object.freeze(/** @type {const} */ (['article', 'picture', 'file', 'folder', 'website']))

/** @returns {State} */
export function initialState () {
  return {
    phase: 'checking',
    error: null,
    bootstrap: { frac: 0, ready: false, msg: 'Not started', blocked: null },
    socks: { state: 'waiting', host: '127.0.0.1', port: 0, msg: '' },
    traffic: { open: 0, total: 0 },
    services: [],
    logs: [],
    busy: null,
    arti: ''
  }
}

// How the name section says which path reads Ethereum for the node, in one line: through the browser's light client (which checks each answer), or from public servers
// (which nothing checks), and why not the light client when it is the second. `path` and `why` are what the node reports (`node/worker/ethereum-reads.js`, and the
// name calls' `boards` answer); a reason a newer node adds is read as the light client not answering, never as a blank.

/** @typedef {{ path?: string, why?: string, lightClient?: number, public?: number }} Reads what the node reports of the path that reads Ethereum, and how many reads each path made */

/** The reasons that mean the light client is off or the person did not allow it for this app: the browser gave no handle, or refused the question. */
const NOT_ALLOWED = new Set(['no-handle', 'denied', 'closed'])

/**
 * @param {Reads | null | undefined} reads the node's answer
 * @returns {string | null} the line, or null for a node that says nothing of it
 */
export function ethereumWords (reads) {
  if (reads === null || reads === undefined || typeof reads.path !== 'string') return null
  switch (reads.path) {
    case 'light-client': return 'Ethereum is read through your browser\'s light client, which checks each answer.'
    case 'asking': return 'Your browser is asking whether this app may read Ethereum through its light client. Until you answer, public servers are used.'
    case 'none': return 'This node reads no Ethereum (it runs without the internet).'
    default:
      if (reads.why === 'unsupported') return 'Ethereum is read from public servers: this browser has no light client for apps, so their answers are not checked.'
      if (NOT_ALLOWED.has(String(reads.why))) return 'Ethereum is read from public servers: your browser\'s light client is off or was not allowed for this app, so their answers are not checked.'
      return 'Ethereum is read from public servers: your browser\'s light client did not answer, so their answers are not checked.'
  }
}

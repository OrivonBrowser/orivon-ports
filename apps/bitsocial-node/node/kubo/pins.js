// Pins and unpins in the order they were asked for, one at a time. The node runs one pin at a time, a second asked
// meanwhile waits in the node client, and the order matters here: a root pinned and the root before it unpinned
// must not cross.

/** @param {{ pin: (cid: string) => Promise<unknown>, unpin: (cid: string) => Promise<boolean> }} node */
export function createPinQueue (node) {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve()

  /** @template T @param {() => Promise<T>} job @returns {Promise<T>} */
  function enqueue (job) {
    const run = tail.then(job, job)
    tail = run.catch(() => {})
    return run
  }

  return {
    /** @param {string} cid */
    pin: (cid) => enqueue(() => node.pin(cid)),
    /** @param {string} cid */
    unpin: (cid) => enqueue(() => node.unpin(cid)),
    /** Resolves once everything asked so far is done. */
    settle: () => tail.then(() => undefined)
  }
}

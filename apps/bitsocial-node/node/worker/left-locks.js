// What a killed node leaves behind in its own folder. Where SQLite has no file locks (WASI) it keeps a lock as a
// directory beside the database, `<db>.lock`, taken and removed around each transaction, and nothing removes it when
// the process that made it is killed. A Worker is killed in the middle of one when the last page of its app closes or
// navigates, and the next node then fails every start with "database is locked".
//
// The directories are removed only when no node answers on the node's API port: whoever holds a lock then is gone.

/** The lock directories of the node's two databases, which sit in the same folder. */
export const LOCK_NAMES = Object.freeze(['blocks.db.lock', 'keys.db.lock'])

/**
 * @typedef {object} LeftLocksOptions
 * @property {string} directory the node's folder, where `blocks.db` and `keys.db` are
 * @property {(path: string) => Promise<boolean>} removeDir removes the directory and says whether it was there
 * @property {() => Promise<boolean>} alive whether a node answers on the API port, with any status
 * @property {(line: string) => void} [log]
 */

/**
 * Removes the lock directories a node that was killed left, and says which it removed.
 * @param {LeftLocksOptions} options @returns {Promise<string[]>}
 */
export async function clearLeftLocks ({ directory, removeDir, alive, log = () => {} }) {
  if (await alive().catch(() => true)) return []
  /** @type {string[]} */
  const removed = []
  for (const name of LOCK_NAMES) {
    try {
      if (await removeDir(`${directory}/${name}`)) removed.push(name)
    } catch (error) {
      log(`could not remove the lock a killed node left (${name}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (removed.length > 0) log(`removed what a killed node left: ${removed.join(', ')}`)
  return removed
}

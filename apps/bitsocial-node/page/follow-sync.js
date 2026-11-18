// Tells the node which communities the app's account follows, so that seeding can keep them. The account lives in the page's own
// IndexedDB (the app's account store, `bitsocialReactHooks-accounts`), which the Worker cannot read: the page reads the active
// account's subscriptions and sends them, when they change, to the node's `seeding/follow` call. It never creates a database: a
// page that has no account yet sends nothing.

export const ACCOUNTS_DATABASE = 'bitsocialReactHooks-accounts'
export const METADATA_DATABASE = 'bitsocialReactHooks-accountsMetadata'
/** The store localforage keeps its pairs in. */
const STORE = 'keyvaluepairs'
export const CHECK_EVERY_MS = 30_000

/** @param {{ error: unknown }} request @returns {Error} */
const failed = (request) => (request.error instanceof Error ? request.error : new Error('IndexedDB failed'))

/**
 * One value of a localforage database, or undefined when the database, the store or the key does not exist.
 * @param {IDBFactory} factory @param {string} database @param {string} key
 * @returns {Promise<unknown>}
 */
function readKey (factory, database, key) {
  return new Promise((resolve, reject) => {
    const opening = factory.open(database)
    // A database that does not exist is created by opening it: aborting the upgrade leaves nothing behind.
    opening.onupgradeneeded = () => { opening.transaction?.abort() }
    opening.onerror = () => { if (opening.error?.name === 'AbortError') resolve(undefined); else reject(failed(opening)) }
    opening.onsuccess = () => {
      const db = opening.result
      if (!db.objectStoreNames.contains(STORE)) { db.close(); resolve(undefined); return }
      const asking = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      asking.onsuccess = () => { db.close(); resolve(asking.result) }
      asking.onerror = () => { db.close(); reject(failed(asking)) }
    }
  })
}

/**
 * The communities the active account follows, as it lists them; null when there is no account to read or it cannot be read.
 * @param {IDBFactory | undefined} factory
 * @returns {Promise<string[] | null>}
 */
export async function readFollowed (factory) {
  if (factory === undefined) return null
  try {
    const active = await readKey(factory, METADATA_DATABASE, 'activeAccountId')
    if (typeof active !== 'string' || active === '') return null
    const account = /** @type {{ subscriptions?: unknown } | undefined} */ (await readKey(factory, ACCOUNTS_DATABASE, active))
    if (typeof account !== 'object' || account === null) return null
    return Array.isArray(account.subscriptions) ? account.subscriptions.filter((one) => typeof one === 'string') : []
  } catch { return null }
}

/**
 * Sends the follow list now and again whenever it changes, until stopped. A list that could not be read, or a node that did not
 * take it, is tried again at the next check.
 * @param {{ seeding?: (call: string, body: Record<string, unknown>) => Promise<unknown> }} handle
 * @param {{ read?: () => Promise<string[] | null>, everyMs?: number }} [options]
 * @returns {() => void} stop
 */
export function startFollowSync (handle, { read = () => readFollowed(globalThis.indexedDB), everyMs = CHECK_EVERY_MS } = {}) {
  if (typeof handle.seeding !== 'function') return () => {}
  let sent = ''
  let stopped = false
  let running = false
  async function check () {
    if (stopped || running) return
    running = true
    try {
      const list = await read()
      if (list === null || stopped) return
      const key = JSON.stringify([...new Set(list)].sort())
      if (key === sent) return
      await handle.seeding?.('follow', { addresses: [...new Set(list)] })
      sent = key
    } catch { /* the node is not taking calls yet, or has no seeding: asked again at the next check */ } finally { running = false }
  }
  check().catch(() => {})
  const timer = setInterval(() => { check().catch(() => {}) }, everyMs)
  return () => { stopped = true; clearInterval(timer) }
}

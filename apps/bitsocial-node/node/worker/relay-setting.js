// The relay a person names for the node, kept in the app's files (`relay.json`) so it holds after a restart. A node behind a home
// router needs a relay that holds a place for it; Orivon names none, so the person does, from the dashboard. What the page's
// own configuration names is the starting value; what the person saves takes its place, and removing it leaves the node with none.
// A change restarts the node (its data stays): the relay is one of the options it is started with.

import { ConfigError } from './board-config.js'
import { checkRelay } from './config.js'

/** The node component in this build has no `--relay`: 409. */
export class UnsupportedError extends Error {}

/**
 * @param {{
 *   file: string, fs: import('./board-config.js').FileApi | null, fromConfig?: string, isolated?: boolean,
 *   supported: () => boolean, restart: () => void | Promise<void>, log?: (line: string) => void
 * }} options `fromConfig` is the relay the Worker's configuration names; `restart` starts the node again with the setting `current()` gives
 */
export function relaySetting ({ file, fs, fromConfig, isolated = false, supported, restart, log = () => {} }) {
  /** @type {string | null | undefined} undefined: nothing saved; null: the person removed it */
  let saved
  try {
    const kept = fs === null ? undefined : JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (kept?.relay === null) saved = null
    else if (typeof kept?.relay === 'string') saved = checkRelay(kept.relay, isolated)
  } catch { saved = undefined }

  const current = () => {
    const relay = saved === undefined ? fromConfig : saved ?? undefined
    return { relay, source: /** @type {'saved' | 'page' | 'none'} */ (saved === undefined ? (fromConfig === undefined ? 'none' : 'page') : saved === null ? 'none' : 'saved') }
  }

  /** @param {string | null} next */
  async function change (next) {
    if (!supported()) throw new UnsupportedError('this node component has no --relay: it cannot hold a place on a relay')
    const before = current().relay
    saved = next
    if (fs !== null) {
      fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ relay: next })}\n`)
      fs.renameSync(`${file}.tmp`, file)
    }
    if (current().relay === before) return current()
    log(next === null ? 'relay removed: the node starts again without one' : 'relay set: the node starts again with it')
    await restart()
    return current()
  }

  return {
    current,
    /** @param {unknown} address `/ip4|ip6|dns4|dns6/<host>/tcp/<port>/p2p/<relay peer id>` */
    set (address) {
      try { return change(checkRelay(address, isolated)) } catch (error) { throw error instanceof UnsupportedError ? error : new ConfigError(error instanceof Error ? error.message : String(error)) }
    },
    clear: () => change(null)
  }
}

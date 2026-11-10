// What a move reads from the chain: who holds the ID and whether the holder can write its records, the holder's own resolver
// and what it carries, and the records of the resolver the ID has now. Nothing is remembered; every call asks again. The
// reads run one after another because a node takes only a few questions at once.

import { sameAddress } from './sdk/abi.js'
import { attribution, recordsAt } from './sdk/orivonid.js'
import { resolverFor } from './register-reads.js'

/**
 * @param {import('./sdk/chain.js').Chain} chain
 * @param {string} label
 * @param {string} holder
 * @param {{ keys: string[] }} options the text records to read from both resolvers
 * @returns {Promise<import('./move-model.js').Facts>}
 */
export async function observeMove (chain, label, holder, { keys }) {
  const attributed = await attribution(chain, label, holder)
  const current = attributed.records.resolver
  const target = await resolverFor(chain, holder)
  const old = current !== null && !sameAddress(current, target.address) ? await recordsAt(chain, current, label, keys) : null
  const found = target.mode === 'reuse' ? await recordsAt(chain, target.address, label, keys) : null
  return { label, holder, current, target, old, found, attribution: attributed }
}

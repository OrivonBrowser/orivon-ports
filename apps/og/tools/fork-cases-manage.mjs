// The cases of the fork run for a name the account holds: fix its controller (unwrapped, and wrapped through unwrap and wrap again),
// give it away (unwrapped with `unsetController` and the primary name ended first, and wrapped as a token), clear records, set the
// primary name, and wrap and unwrap with the site written again. After each change the resolver's own `resolveOg` says what the name
// answers, and the reason of each record, so the page's words about what a change does to a site are checked against the real rule.

import { encodeCall, sameAddress, ZERO_ADDRESS } from '../site/sdk/abi.js'
import { keyOf } from '../site/resolver/og-name.js'
import { WRAPPER } from '../site/resolver/og-pins.js'
import { readFacts } from '../site/register-reads.js'
import { createWrapperTx, setControllerTx, setTextTx, transferTx, wrapTx } from '../site/register-tx.js'
import { SITE } from './fork-world.mjs'

const RIVAL = `0x${'b2'.repeat(20)}`
const RECEIVER = `0x${'c0'.repeat(20)}`
const KEYS = [SITE.key]

/** @param {import('./fork-world.mjs').World} w @returns {import('./fork-world.mjs').Case[]} */
export default (w) => {
  const { register, resolverSays, summary, check, sendAs, hexOf, ask } = w
  /** @param {{ to: string, data: Uint8Array }} tx @param {string} from */
  const as = (from, tx) => sendAs(from, tx.to, hexOf(tx.data))
  /** @param {string} label @param {boolean} wrapped @param {Uint8Array} [key] */
  async function held (label, wrapped, key) {
    const run = await register({ label, tip: false, ...(key === undefined ? {} : { key }) })
    const view = await (wrapped ? run.start() : run.startWith(false))
    check(view['phase'] === 'done', `the name ${label} was registered first`, summary(view))
    return run
  }
  /** The state the page plans from: the name's holder, token and controller, with the account's primary name. @param {string} label @param {Awaited<ReturnType<typeof held>>} run */
  const factsOf = (label, run) => readFacts(run.chain, label, 'latest', KEYS, run.account)
  const label = (/** @type {string} */ prefix) => `${prefix}${Date.now() % 1e6}`
  /** @param {unknown[]} records */
  const answered = (records) => records.length

  return [
    {
      name: 'fix controller, unwrapped, then confirm the site again',
      async run () {
        const name = label('ogfkctl')
        const run = await held(name, false)
        await as(run.account, setControllerTx(keyOf(name), RIVAL))
        const before = await resolverSays(name, run.chain)
        check(answered(before.records) === 0 && before.reasons[SITE.key] === 'controller-is-not-the-holder', 'another controller keeps the site out', before)
        const fixed = await run.change({ action: 'fixController', label: name })
        const facts = await factsOf(name, run)
        check(fixed['phase'] === 'done' && sameAddress(String(facts.controller), run.account), 'the account is the controller', summary(fixed))
        const stale = await resolverSays(name, run.chain)
        check(answered(stale.records) === 0 && stale.reasons[SITE.key] === 'set-before-the-last-NewController', 'the site waits to be confirmed again', stale)
        const again = await run.change({ action: 'reconfirm', label: name, keys: KEYS })
        const after = await resolverSays(name, run.chain)
        check(again['phase'] === 'done' && answered(after.records) === 1, 'the site counts after it is confirmed again', after)
        return { fixed: summary(fixed), confirmed: summary(again), resolver: after }
      }
    },
    {
      name: 'fix controller, wrapped: unwrap, setController, createWrapper, transfer, wrap',
      async run () {
        const name = label('ogfkwctl')
        const key = keyOf(name)
        const run = await held(name, false)
        for (const tx of [setControllerTx(key, RIVAL), createWrapperTx(key), transferTx(key, WRAPPER), wrapTx(key)]) await as(run.account, tx)
        const before = await factsOf(name, run)
        check(sameAddress(before.registryOwner, WRAPPER) && sameAddress(String(before.controller), RIVAL) && sameAddress(String(before.ownerOf), run.account), 'wrapped with another controller', before)
        const fixed = await run.change({ action: 'fixController', label: name })
        const facts = await factsOf(name, run)
        check(fixed['phase'] === 'done' && sameAddress(String(facts.controller), run.account) && sameAddress(String(facts.ownerOf), run.account), 'wrapped again with the account as controller', summary(fixed))
        check(BigInt(facts.nameToId) !== BigInt(before.nameToId), 'the token number changed', { before: String(before.nameToId), after: String(facts.nameToId) })
        const old = await ask('eth_call', { to: WRAPPER, data: hexOf(encodeCall('ownerOf(uint256)', [BigInt(before.nameToId)])) }, 'latest').then(() => 'answered', () => 'reverted')
        check(old === 'reverted', 'the old token no longer exists')
        const again = await run.change({ action: 'reconfirm', label: name, keys: KEYS })
        const after = await resolverSays(name, run.chain)
        check(again['phase'] === 'done' && answered(after.records) === 1, 'the site counts after it is confirmed again', after)
        return { fixed: summary(fixed), confirmed: summary(again), resolver: after }
      }
    },
    {
      name: 'transfer, unwrapped, with the controller removed and the primary name ended',
      async run () {
        const name = label('ogfkxfr')
        const key = keyOf(name)
        const run = await held(name, false)
        await as(run.account, setControllerTx(key, run.account))
        const primary = await run.change({ action: 'setPrimary', label: name })
        const before = await factsOf(name, run)
        check(primary['phase'] === 'done' && before.primary === key && sameAddress(String(before.resolvesTo), run.account), 'the primary name is set', summary(primary))
        const sent = await run.change({ action: 'transfer', label: name, to: RECEIVER, unsetController: true, unsetPrimary: true })
        const facts = await factsOf(name, run)
        check(sent['phase'] === 'done' && sameAddress(facts.registryOwner, RECEIVER) && sameAddress(String(facts.controller), ZERO_ADDRESS), 'the receiver holds it with no controller', summary(sent))
        check(facts.primary === `0x${'0'.repeat(64)}` && sameAddress(String(facts.resolvesTo), ZERO_ADDRESS), 'the primary name is gone', { primary: facts.primary, resolvesTo: facts.resolvesTo })
        const stale = await resolverSays(name, run.chain)
        check(answered(stale.records) === 0, 'the seller\'s site does not count for the receiver', stale)
        await as(RECEIVER, setTextTx(key, SITE.key, SITE.text))
        const after = await resolverSays(name, run.chain)
        check(answered(after.records) === 1, 'the receiver\'s own write counts at once', after)
        return { primary: summary(primary), transferred: summary(sent), before: stale, after }
      }
    },
    {
      name: 'transfer, wrapped: the token goes, the controller stays',
      async run () {
        const name = label('ogfkwxfr')
        const run = await held(name, true)
        const sent = await run.change({ action: 'transfer', label: name, to: RECEIVER })
        const facts = await factsOf(name, run)
        check(sent['phase'] === 'done' && sameAddress(String(facts.ownerOf), RECEIVER) && sameAddress(String(facts.controller), run.account), 'the receiver holds the token and the controller is the seller', summary(sent))
        const says = await resolverSays(name, run.chain)
        check(answered(says.records) === 0 && says.reasons[SITE.key] === 'controller-is-not-the-holder', 'the records wait for the receiver to fix the controller', says)
        return { transferred: summary(sent), resolver: says }
      }
    },
    {
      name: 'clean up a wrapped name, then give it away',
      async run () {
        const name = label('ogfkcln')
        const run = await held(name, true)
        const cleaned = await run.change({ action: 'cleanUp', label: name })
        const facts = await factsOf(name, run)
        check(cleaned['phase'] === 'done' && sameAddress(String(facts.controller), ZERO_ADDRESS) && sameAddress(String(facts.ownerOf), run.account), 'wrapped again with no controller', summary(cleaned))
        const sent = await run.change({ action: 'transfer', label: name, to: RECEIVER })
        const after = await factsOf(name, run)
        const says = await resolverSays(name, run.chain)
        check(sent['phase'] === 'done' && sameAddress(String(after.ownerOf), RECEIVER) && says.reasons[SITE.key] !== 'controller-is-not-the-holder', 'the receiver holds a token with no controller behind it', says)
        return { cleaned: summary(cleaned), transferred: summary(sent), resolver: says }
      }
    },
    {
      name: 'clear records',
      async run () {
        const name = label('ogfkclr')
        const run = await held(name, false)
        const cleared = await run.change({ action: 'clear', label: name, keys: KEYS })
        const facts = await factsOf(name, run)
        const says = await resolverSays(name, run.chain)
        check(cleared['phase'] === 'done' && (facts.values[SITE.key] ?? '') === '' && answered(says.records) === 0, 'the record is empty and the resolver answers nothing', says)
        return { cleared: summary(cleared), resolver: says }
      }
    },
    {
      name: 'set primary replaces the previous one',
      async run () {
        const first = label('ogfkpa')
        const second = label('ogfkpb')
        const run = await held(first, false)
        await held(second, false, run.key)
        const one = await run.change({ action: 'setPrimary', label: first })
        const two = await run.change({ action: 'setPrimary', label: second })
        const facts = await factsOf(second, run)
        const old = await factsOf(first, run)
        check(one['phase'] === 'done' && two['phase'] === 'done' && facts.primary === keyOf(second) && sameAddress(String(facts.resolvesTo), run.account), 'the second name is the primary', summary(two))
        check(sameAddress(String(old.resolvesTo), ZERO_ADDRESS), 'the first name no longer resolves to the account', { resolvesTo: old.resolvesTo })
        return { first: summary(one), replaced: summary(two) }
      }
    },
    {
      name: 'wrap and unwrap with the site written again',
      async run () {
        const name = label('ogfkwu')
        const run = await held(name, false)
        const keep = [{ key: SITE.key, text: SITE.text }]
        const wrapped = await run.change({ action: 'wrap', label: name, keep })
        const during = await resolverSays(name, run.chain)
        check(wrapped['phase'] === 'done' && answered(during.records) === 1, 'the site counts after wrapping', during)
        const unwrapped = await run.change({ action: 'unwrap', label: name, keep })
        const after = await resolverSays(name, run.chain)
        const facts = await factsOf(name, run)
        check(unwrapped['phase'] === 'done' && sameAddress(facts.registryOwner, run.account) && answered(after.records) === 1, 'the site counts after unwrapping', after)
        return { wrapped: summary(wrapped), unwrapped: summary(unwrapped), resolver: after }
      }
    }
  ]
}

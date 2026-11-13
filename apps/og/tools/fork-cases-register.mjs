// The registration cases of the fork run: wrapped with one confirmation, unwrapped, a wallet that signs one by one, a name taken in the
// middle, wrapping off before, in the middle of and on the way to the wrapper, and no tip. Each ends by asking the resolver's own
// `resolveOg` what the new name answers.

import { sameAddress } from '../site/sdk/abi.js'
import { keyOf } from '../site/resolver/og-name.js'
import { WRAPPER } from '../site/resolver/og-pins.js'
import { readFacts } from '../site/register-reads.js'
import { reserveTx } from '../site/register-tx.js'
import { SITE } from './fork-world.mjs'

/** @param {import('./fork-world.mjs').World} w @returns {import('./fork-world.mjs').Case[]} */
export default (w) => {
  const { register, resolverSays, summary, check, balance, flipWrapping, sendAs, hexOf, ask, tipAddress } = w
  return [
    {
      name: 'wrapped, one confirmation',
      async run () {
        const label = `ogfkwrp${Date.now() % 1e6}`
        const run = await register({ label })
        const receiver = await tipAddress(run.chain)
        const tipBefore = await balance(receiver)
        const view = await run.start()
        const facts = await readFacts(run.chain, label, 'latest', [SITE.key])
        const says = await resolverSays(label, run.chain)
        check(view['phase'] === 'done' && run.handles.counts.confirmations === 1, 'series signed once and completed', { ...summary(view), confirmations: run.handles.counts.confirmations, outcome: view['outcome'] })
        check(sameAddress(facts.registryOwner, WRAPPER) && sameAddress(String(facts.ownerOf), run.account), 'wrapper holds the name and the person holds the token')
        check(facts.values[SITE.key] === SITE.text && says.records.length === 1, 'resolver answers the site')
        check(await balance(receiver) - tipBefore === BigInt(view['costs'].tipWei) && view['costs'].tipWei > 0n, 'the tip arrived')
        return { ...summary(view), confirmations: run.handles.counts.confirmations, resolver: says }
      }
    },
    {
      name: 'unwrapped',
      async run () {
        const label = `ogfkplain${Date.now() % 1e6}`
        const run = await register({ label, wrapped: false })
        const view = await run.start()
        const says = await resolverSays(label, run.chain)
        const facts = await readFacts(run.chain, label, 'latest', [SITE.key])
        check(view['phase'] === 'done' && sameAddress(facts.registryOwner, run.account), 'the person holds the name in the registry')
        check(says.records.length === 1, 'resolver answers the site')
        return { ...summary(view), confirmations: run.handles.counts.confirmations, resolver: says }
      }
    },
    {
      name: 'wrapped, wallet signs one by one',
      async run () {
        const label = `ogfkeach${Date.now() % 1e6}`
        const run = await register({ label, series: false })
        const view = await run.start()
        const says = await resolverSays(label, run.chain)
        check(view['phase'] === 'done' && run.handles.counts.confirmations === view['steps'].length, 'one confirmation for each step')
        check(says.records.length === 1, 'resolver answers the site')
        return { ...summary(view), confirmations: run.handles.counts.confirmations, resolver: says }
      }
    },
    {
      name: 'name taken mid-series',
      async run () {
        const label = `ogfktaken${Date.now() % 1e6}`
        const rival = `0x${'b2'.repeat(20)}`
        const run = await register({
          label,
          beforeSend: async (index) => { if (index === 0) await sendAs(rival, reserveTx(keyOf(label)).to, hexOf(reserveTx(keyOf(label)).data)) }
        })
        const receiver = await tipAddress(run.chain)
        const tipBefore = await balance(receiver)
        const view = await run.start()
        const facts = await readFacts(run.chain, label, 'latest', [])
        check(view['phase'] === 'stopped' && view['outcome'].kind === 'taken', 'stopped as taken')
        check(sameAddress(facts.registryOwner, rival), 'the rival holds the name')
        check(run.handles.counts.sent.length === 1, 'nothing after the reserve was sent')
        check(await balance(receiver) === tipBefore, 'no tip was sent')
        return { ...summary(view), confirmations: run.handles.counts.confirmations, sentTransactions: run.handles.counts.sent.length }
      }
    },
    {
      name: 'wrapping off before the series',
      async run () {
        const label = `ogfkoff${Date.now() % 1e6}`
        await flipWrapping()
        try {
          const run = await register({ label })
          const view = await run.start()
          const facts = await readFacts(run.chain, label, 'latest', [])
          check(view['outcome']?.kind === 'wrapOff' && view['outcome'].offer === 'unwrapped', 'stopped as wrapOff with the unwrapped offer')
          check(run.handles.counts.confirmations === 0 && run.handles.counts.sent.length === 0, 'nothing was signed or sent')
          check(sameAddress(facts.registryOwner, '0x0000000000000000000000000000000000000000'), 'the name is still free')
          const plain = await run.startWith(false)
          const says = await resolverSays(label, run.chain)
          check(plain['phase'] === 'done' && says.records.length === 1, 'the unwrapped registration completes and the resolver answers it')
          return { refused: summary(view), unwrapped: summary(plain), resolver: says }
        } finally {
          await flipWrapping()
        }
      }
    },
    {
      name: 'wrapping off in the middle of the series',
      async run () {
        const label = `ogfkmid${Date.now() % 1e6}`
        let flipped = false
        const run = await register({ label, beforeSend: async (index) => { if (index === 1 && !flipped) { flipped = true; await flipWrapping() } } })
        try {
          const view = await run.start()
          const facts = await readFacts(run.chain, label, 'latest', [])
          check(view['outcome']?.kind === 'wrapOff' && view['outcome'].at === 'createWrapper' && view['outcome'].offer === 'unwrapped', 'stopped before createWrapper with the unwrapped offer')
          check(sameAddress(facts.registryOwner, run.account), 'the name is the person\'s in the registry, not in the wrapper')
          check(run.handles.counts.sent.length === 2, 'createWrapper, transfer and wrap were not sent')
          const plain = await run.startWith(false)
          const says = await resolverSays(label, run.chain)
          check(plain['phase'] === 'done' && says.records.length === 1, 'kept unwrapped, and the resolver answers it')
          return { stopped: summary(view), unwrapped: summary(plain), resolver: says }
        } finally {
          await flipWrapping()
        }
      }
    },
    {
      name: 'wrapping off on the way to the wrapper, then finished',
      async run () {
        const label = `ogfklate${Date.now() % 1e6}`
        let flipped = false
        const run = await register({ label, beforeSend: async (index) => { if (index === 3 && !flipped) { flipped = true; await flipWrapping() } } })
        let switchedBack = false
        try {
          const view = await run.start()
          const stranded = await readFacts(run.chain, label, 'latest', [])
          check(view['outcome']?.kind === 'wrapOffLate' && view['outcome'].offer === 'finishWrapping', 'stopped before wrap with the finish offer')
          check(sameAddress(stranded.registryOwner, WRAPPER) && sameAddress(String(stranded.waitForWrap), run.account), 'the wrapper waits for the person')
          await flipWrapping()
          switchedBack = true
          const finished = await run.startWith(true)
          const says = await resolverSays(label, run.chain)
          const facts = await readFacts(run.chain, label, 'latest', [SITE.key])
          check(finished['phase'] === 'done' && sameAddress(String(facts.ownerOf), run.account), 'the token reached the person', { finished: summary(finished), ownerOf: facts.ownerOf })
          return { stopped: summary(view), finished: summary(finished), resolver: says }
        } finally {
          if (!switchedBack) await flipWrapping()
        }
      }
    },
    {
      name: 'tip to a contract',
      async run () {
        const label = `ogfkcon${Date.now() % 1e6}`
        const run = await register({ label, wrapped: false })
        const receiver = await tipAddress(run.chain)
        const before = /** @type {string} */ (await ask('eth_getCode', receiver, 'latest'))
        // A contract at the tip's address whose receive writes a storage slot: far more than the 21,000 gas of a bare transfer.
        await ask('anvil_setCode', receiver, '0x6001600055')
        try {
          const tipBefore = await balance(receiver)
          const view = await run.start()
          const tip = view['steps'].find((/** @type {any} */ step) => step.id === 'tip')
          check(view['phase'] === 'done', 'registered, and the tip reached the contract', summary(view))
          check(tip !== undefined && tip.gas > 21_000 && tip.gas <= 100_000, 'the tip was signed with more than a transfer needs, at most 100,000', { tip, asked: view['request'].tip })
          check(await balance(receiver) - tipBefore === BigInt(view['costs'].tipWei) && view['costs'].tipWei > 0n, 'the contract received the tip')
          return { ...summary(view), tipGasLimit: tip?.gas ?? null, tipGasUsed: tip?.gasUsed ?? null }
        } finally {
          await ask('anvil_setCode', receiver, before)
        }
      }
    },
    {
      name: 'continue after a stop at the tip',
      async run () {
        const label = `ogfkdbl${Date.now() % 1e6}`
        // The tip is mined, and the page is told the broadcast timed out: it cannot know. Continue must read the receipt, not pay again.
        const run = await register({
          label,
          wrapped: false,
          beforeSend: async (index, _context, raw) => {
            if (index !== 2) return
            await ask('eth_sendRawTransaction', `0x${Buffer.from(raw).toString('hex')}`)
            throw Object.assign(new Error('the node took too long to answer'), { code: 'timeout' })
          }
        })
        const receiver = await tipAddress(run.chain)
        const tipBefore = await balance(receiver)
        const first = await run.start()
        check(first['phase'] === 'stopped' && first['outcome'].kind === 'unknownOutcome' && first['outcome'].at === 'tip', 'stopped at the tip, outcome not known', summary(first))
        const second = await run.continueFrom(first)
        const paid = await balance(receiver) - tipBefore
        check(second['phase'] === 'done' && second['steps'].length === 0, 'Continue had nothing to send', summary(second))
        check(paid === BigInt(first['request'].tip.wei), 'the tip was paid once', { paid })
        check(second['notes'].some((/** @type {string} */ note) => /already sent/.test(note)), 'the person was told the tip had gone out', second['notes'])
        return { first: summary(first), second: summary(second), paid }
      }
    },
    {
      name: 'wrapped, tip unticked',
      async run () {
        const label = `ogfknotip${Date.now() % 1e6}`
        const run = await register({ label, tip: false })
        const receiver = await tipAddress(run.chain)
        const tipBefore = await balance(receiver)
        const view = await run.start()
        const says = await resolverSays(label, run.chain)
        check(view['phase'] === 'done' && !view['steps'].some((/** @type {any} */ step) => step.id === 'tip'), 'no tip step')
        check(await balance(receiver) === tipBefore, 'no tip was sent')
        check(says.records.length === 1, 'resolver answers the site')
        return { ...summary(view), confirmations: run.handles.counts.confirmations, resolver: says }
      }
    }
  ]
}

import { describe, expect, it } from 'vitest'
import { keyOf } from '../site/resolver/og-name.js'
import { WRAPPER } from '../site/resolver/og-pins.js'
import { MANAGE_KEYS } from '../site/manage-flow.js'
import { menuOf } from '../site/manage-model.js'
import { chipsOf, rowOf } from '../site/names-model.js'
import { readHints, readWrappedTokens } from '../site/names-reads.js'
import { readFacts } from '../site/register-reads.js'
import { describeName } from '../site/search-model.js'
import { SPELLING_CHIP } from '../site/words.js'
import { ACCOUNT, RIVAL } from './support/linagee-world.ts'
import { harness } from './support/manage-harness.ts'

// The registry and the wrapper take any bytes as a name, so an account can hold "Harbor": a label the name rules (ENSIP-15) would write
// "harbor", and that Orivon therefore never opens. Whatever route brings such a label to a page, the page must not say its site counts.
const SITE = { key: 'content.ipfs', text: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' }
const wrappedAs = (label: string) => ({
  owner: { [keyOf(label)]: WRAPPER }, controller: { [keyOf(label)]: ACCOUNT }, nameToId: { [keyOf(label)]: 5n }, idToName: { '5': keyOf(label) }, tokenOwner: { '5': ACCOUNT }, nextId: 6n,
  texts: { [keyOf(label)]: { [SITE.key]: SITE.text } }
})
const unwrappedAs = (label: string) => ({ owner: { [keyOf(label)]: ACCOUNT }, controller: { [keyOf(label)]: ACCOUNT }, texts: { [keyOf(label)]: { [SITE.key]: SITE.text } } })

async function viewOf (made: ReturnType<typeof harness>, label: string) {
  const inspection = await made.inspect(label)
  const facts = await readFacts(made.chain, label, inspection.block, MANAGE_KEYS, ACCOUNT)
  return describeName({ label, inspection, facts, account: ACCOUNT, keys: MANAGE_KEYS })
}

describe('a name held in a spelling Orivon does not open', () => {
  it('is marked so, and its site is not said to count, whichever way its label reaches the page', async () => {
    const made = harness({ ...wrappedAs('Harbor'), primary: { [ACCOUNT.toLowerCase()]: keyOf('Harbor') } })
    const fromToken = (await readWrappedTokens(made.chain, ACCOUNT)).tokens.map((token) => token.label)
    const fromHint = await readHints(made.chain, ACCOUNT)
    expect(fromToken).toEqual(['Harbor'])
    expect(fromHint).toEqual(['Harbor'])
    // The same label from this device's own list and from the address bar reaches the page the same way: through `describeName`.
    for (const label of [...fromToken, ...fromHint, 'Harbor']) {
      const view = await viewOf(made, label)
      expect(view.openable, label).toBe(false)
      expect(view.rows, label).toEqual([expect.objectContaining({ key: SITE.key, counts: false, reason: 'unopenable' })])
      expect(view.rows[0]?.words).toMatch(/^Does not count: Orivon opens only the standard spelling/)
      const row = rowOf({ view, account: ACCOUNT, primary: null })
      expect(row.site.tone).toBe('warn')
      expect(row.controller).toEqual({ ok: true, words: null })
      const chips = chipsOf(row, view).map((chip) => chip.text)
      expect(chips).toContain(SPELLING_CHIP)
      expect(chips).not.toContain('Site counts')
    }
  })

  it('is not marked when the label is the standard spelling, so the same chain state counts for "harbor"', async () => {
    const made = harness(wrappedAs('harbor'))
    const view = await viewOf(made, 'harbor')
    expect(view.openable).toBe(true)
    expect(view.rows[0]).toMatchObject({ key: SITE.key, reason: expect.not.stringMatching(/unopenable/) })
  })

  it('offers only to give it away and, when it is wrapped, to unwrap it; a name the wrapper waits to finish is still finished', async () => {
    const wrapped = await viewOf(harness(wrappedAs('Harbor')), 'Harbor')
    expect(menuOf({ view: wrapped, account: ACCOUNT }).map((one) => one.action)).toEqual(['transfer', 'unwrap'])
    const unwrapped = await viewOf(harness(unwrappedAs('Harbor')), 'Harbor')
    expect(menuOf({ view: unwrapped, account: ACCOUNT }).map((one) => one.action)).toEqual(['transfer'])
    const stuck = await viewOf(harness({ owner: { [keyOf('Harbor')]: WRAPPER }, waitForWrap: { [keyOf('Harbor')]: ACCOUNT } }), 'Harbor')
    expect(menuOf({ view: stuck, account: ACCOUNT }).map((one) => one.action)).toEqual(['wrap'])
    const standard = await viewOf(harness(wrappedAs('harbor')), 'harbor')
    expect(menuOf({ view: standard, account: ACCOUNT }).map((one) => one.action)).toContain('setSite')
  })

  it('is refused every change but giving it away and unwrapping, with nothing sent', async () => {
    const made = harness(wrappedAs('Harbor'))
    for (const action of ['setSite', 'reconfirm', 'clear', 'setPrimary', 'fixController', 'cleanUp', 'wrap']) {
      const view = await made.run({ action, label: 'Harbor', site: SITE, keys: [SITE.key] })
      expect(view['phase'], action).toBe('refused')
      expect(view['problem'], action).toMatch(/standard spelling/)
    }
    expect(made.labels()).toEqual([])
    const unwrapped = await made.run({ action: 'unwrap', label: 'Harbor' })
    expect(unwrapped['phase']).toBe('done')
    const given = await made.run({ action: 'transfer', label: 'Harbor', to: RIVAL })
    expect(given['phase']).toBe('done')
    expect(made.setup.world.state.owner[keyOf('Harbor')]).toBe(RIVAL)
  })
})

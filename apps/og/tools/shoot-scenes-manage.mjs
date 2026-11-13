// The scenes of tools/shoot.mjs for the pages of the person's own names: the list, a name's page with each kind of name (wrapped,
// unwrapped, a controller to fix, stranded, a long label, a non-Latin one, one in a spelling Orivon does not open) and its actions, a change that finishes, and one that stops.
// A scene's `seed` is the transactions mined before the page starts, so each name has the history of one that was registered and written to.

import { toChecksumAddress } from '../site/sdk/abi.js'
import { SPELLING_CHIP } from '../site/words.js'
import { createWrapperTx, reserveTx, setControllerTx, setPrimaryTx, setTextTx, transferTx, wrapTx } from '../site/register-tx.js'

const ACCOUNT = toChecksumAddress(`0x${'a1'.repeat(20)}`)
const RIVAL = toChecksumAddress(`0x${'b2'.repeat(20)}`)
const WRAPPER = '0x2Cc8342d7c8BFf5A213eb2cdE39DE9a59b3461A7'
const CID = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const hex = (text) => `0x${Buffer.from(text, 'utf8').toString('hex').padEnd(64, '0')}`
const by = (from, call) => ({ from, to: call.to, data: Buffer.from(call.data).toString('hex') })
const LONG = 'northernlighthousekeeperreef'
const NON_LATIN = '港口'

/** A name registered, wrapped and written to by `holder`; `controller` is who the resolver lets write it. */
const wrapped = (holder, label, controller = holder) => {
  const key = hex(label)
  return [
    by(holder, reserveTx(key)), by(holder, setControllerTx(key, controller)), by(holder, createWrapperTx(key)), by(holder, transferTx(key, WRAPPER)), by(holder, wrapTx(key)),
    by(controller, setTextTx(key, 'content.ipfs', CID))
  ]
}
/** An unwrapped name: the holder is its controller, it carries a site and it is the holder's primary name. */
const unwrapped = (holder, label) => {
  const key = hex(label)
  return [by(holder, reserveTx(key)), by(holder, setControllerTx(key, holder)), by(holder, setTextTx(key, 'content.ipfs', CID)), by(holder, setPrimaryTx(key))]
}
/** A name that was handed to the wrapper and not wrapped. */
const stranded = (holder, label) => {
  const key = hex(label)
  return [by(holder, reserveTx(key)), by(holder, createWrapperTx(key)), by(holder, transferTx(key, WRAPPER))]
}

const SEED = [
  ...wrapped(ACCOUNT, 'harbor'), ...wrapped(ACCOUNT, 'breakwater', RIVAL), ...wrapped(ACCOUNT, LONG), ...wrapped(ACCOUNT, NON_LATIN),
  ...unwrapped(ACCOUNT, 'quayside'), ...stranded(ACCOUNT, 'anchorage')
]
const STORAGE = { [`og-names:${ACCOUNT.toLowerCase()}`]: JSON.stringify(['quayside', 'anchorage']), 'og-names:id': JSON.stringify(['alice']) }
const WORLD = { seed: SEED, storage: STORAGE, state: { ids: { alice: ACCOUNT } } }
/** A name held in a spelling the name rules would write differently: the registry takes any bytes as a name, Orivon opens only the standard one. */
const SPELLING_WORLD = { seed: wrapped(ACCOUNT, 'Harbor'), storage: {}, state: {} }

const go = async (page, hash) => { await page.evaluate((to) => { location.hash = to }, hash) }
const settled = (page) => page.waitForFunction(() => document.body.innerText.includes('What you can do') && !document.body.innerText.includes('Reading'), null, { timeout: 20_000 })
const connect = async (page) => { await page.getByRole('button', { name: 'Connect' }).first().click() }
const open = async (page, name) => { await page.locator(`details.action[data-action="${name}"] > summary`).click() }
const fill = async (page, name, field, text) => { await page.locator(`details.action[data-action="${name}"] input[id$="-${field}"]`).fill(text) }
const tick = async (page, name, field) => { await page.locator(`details.action[data-action="${name}"] input[id$="-${field}"]`).check() }
/** Waits for words in the panel of an action: every panel carries its own review, closed or not, so a page-wide wait could match a hidden one. */
const review = async (page, name, words) => { await page.locator(`details.action[data-action="${name}"]`).getByText(words).first().waitFor({ state: 'visible', timeout: 20_000 }) }
const manage = (label) => async (page) => { await go(page, `#/names/${encodeURIComponent(label)}`); await connect(page); await settled(page) }

/** @returns {{ name: string, run: (page: any) => Promise<void>, expect: string[], [more: string]: unknown }[]} */
export function manageScenes () {
  return [
    {
      ...WORLD, name: 'names',
      async run (page) {
        await go(page, '#/names'); await connect(page)
        await page.waitForFunction(() => document.querySelectorAll('.name-row').length >= 6 && !document.body.innerText.includes('Reading'), null, { timeout: 30_000 })
        await page.waitForSelector('.id-pill[data-state="verified"]', { timeout: 20_000 })
      },
      expect: ['6 names', 'harbor.og', 'breakwater.og', 'Finish wrapping', 'Verified', 'What this proves, and what it does not']
    },
    {
      name: 'names-empty',
      async run (page) { await go(page, '#/names'); await connect(page); await page.waitForSelector('text=No names yet'); await page.waitForSelector('text=No Orivon ID found') },
      expect: ['No names yet', 'Add a name you hold']
    },
    {
      ...WORLD, name: 'manage-wrapped',
      async run (page) {
        await manage('harbor')(page); await open(page, 'transfer'); await fill(page, 'transfer', 'to', RIVAL); await tick(page, 'transfer', 'ok')
        await review(page, 'transfer', 'Send the token to the new holder')
      },
      expect: ['harbor.og', 'Give it away', 'safeTransferFrom', 'Records', 'Orivon ID']
    },
    {
      ...WORLD, name: 'manage-unwrapped',
      async run (page) {
        await manage('quayside')(page); await open(page, 'transfer'); await fill(page, 'transfer', 'to', RIVAL); await tick(page, 'transfer', 'ok')
        await review(page, 'transfer', 'Give the name to the new holder')
      },
      expect: ['quayside.og', 'Remove the controller first', 'End my primary name first', 'End your primary name', 'Remove the controller']
    },
    {
      ...WORLD, name: 'manage-fix',
      async run (page) {
        await manage('breakwater')(page); await open(page, 'setSite'); await fill(page, 'setSite', 'site', CID)
        await page.locator('details.action[data-action="setSite"] button', { hasText: 'Fix the controller' }).click()
        await review(page, 'fixController', 'Unwrap the name')
      },
      expect: ['breakwater.og', 'Needs a look', 'Unwrap the name', 'Hand the name to the wrapper', 'Wrap the name']
    },
    {
      ...WORLD, name: 'manage-stranded',
      async run (page) { await manage('anchorage')(page); await open(page, 'wrap'); await review(page, 'wrap', 'What will be sent') },
      expect: ['anchorage.og', 'Finish wrapping', 'Finish wrapping the name']
    },
    {
      ...WORLD, name: 'manage-long',
      async run (page) { await manage(LONG)(page); await open(page, 'clear') },
      expect: [`${LONG}.og`, 'Clear the records']
    },
    {
      ...WORLD, name: 'manage-non-latin',
      async run (page) { await manage(NON_LATIN)(page); await open(page, 'setPrimary'); await review(page, 'setPrimary', 'What will be sent') },
      expect: [`${NON_LATIN}.og`, 'Make it your primary name']
    },
    {
      ...SPELLING_WORLD, name: 'names-spelling',
      async run (page) { await go(page, '#/names'); await connect(page); await page.waitForFunction(() => document.querySelectorAll('.name-row').length >= 1 && !document.body.innerText.includes('Reading'), null, { timeout: 30_000 }) },
      expect: ['Harbor.og', SPELLING_CHIP]
    },
    {
      ...SPELLING_WORLD, name: 'manage-spelling',
      async run (page) { await manage('Harbor')(page) },
      expect: ['Harbor.og', SPELLING_CHIP, 'Give it away']
    },
    {
      ...WORLD, name: 'manage-done',
      async run (page) {
        await manage('harbor')(page); await open(page, 'setPrimary')
        await page.locator('details.action[data-action="setPrimary"]').getByRole('button', { name: 'Make it my primary name' }).click()
        await page.waitForSelector('text=is your primary name', { timeout: 30_000 })
      },
      expect: ['harbor.og is your primary name', 'Transaction']
    },
    {
      ...WORLD, name: 'manage-site-done',
      async run (page) {
        await manage('harbor')(page); await open(page, 'setSite'); await fill(page, 'setSite', 'site', CID)
        await page.locator('details.action[data-action="setSite"]').getByRole('button', { name: 'Set the site' }).click()
        await page.waitForSelector('text=is set.', { timeout: 30_000 })
      },
      expect: ['The site of harbor.og is set.', 'about 13 minutes', 'Transaction']
    },
    {
      ...WORLD, name: 'manage-stopped', before: [{ index: 0, change: { owner: { [hex('quayside')]: RIVAL } } }],
      async run (page) {
        await manage('quayside')(page); await open(page, 'transfer'); await fill(page, 'transfer', 'to', RIVAL); await tick(page, 'transfer', 'ok')
        await page.locator('details.action[data-action="transfer"]').getByRole('button', { name: 'Give it away' }).click()
        await page.waitForSelector('text=stopped', { timeout: 30_000 })
      },
      expect: ['quayside.og is not yours any more']
    }
  ]
}

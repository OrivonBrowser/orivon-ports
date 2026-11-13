import { describe, expect, it } from 'vitest'
import { ZERO_ADDRESS } from '../site/sdk/abi.js'
import { keyOf } from '../site/resolver/og-name.js'
import { costOf, optionsOf, panelOf, siteRecordOf } from '../site/register-model.js'
import { ACCOUNT, TIP_ADDRESS } from './support/linagee-world.ts'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const KEY = keyOf('harbor')
const facts = (over: Record<string, unknown> = {}) => ({
  key: KEY, registryOwner: ZERO_ADDRESS, nameToId: 0n, idToName: null, ownerOf: null, controller: ZERO_ADDRESS, values: {}, waitForWrap: ZERO_ADDRESS, wrapEnabled: true, ...over
}) as never

describe('siteRecordOf', () => {
  it('maps an IPFS, IPNS, Swarm or Arweave address to the key the resolver reads', () => {
    expect(siteRecordOf(`ipfs://${CID}`)).toMatchObject({ kind: 'site', key: 'content.ipfs', text: `ipfs://${CID}`, label: 'IPFS' })
    expect(siteRecordOf('ipns://k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8')).toMatchObject({ key: 'content.ipfs', label: 'IPNS' })
    expect(siteRecordOf(`bzz://${'AB'.repeat(32)}`)).toMatchObject({ key: 'content.bzz', text: `bzz://${'ab'.repeat(32)}`, label: 'Swarm' })
    expect(siteRecordOf(`ar://${'A'.repeat(43)}`)).toMatchObject({ key: 'content.arw', label: 'Arweave' })
  })

  it('takes a bare content id or Swarm reference as what it is, and trims what was pasted', () => {
    expect(siteRecordOf(`  ${CID}\n`)).toMatchObject({ key: 'content.ipfs', text: `ipfs://${CID}` })
    expect(siteRecordOf('ab'.repeat(32))).toMatchObject({ key: 'content.bzz', text: `bzz://${'ab'.repeat(32)}` })
  })

  it('is no site for an empty field, and a problem in words for anything the resolver would not answer with', () => {
    expect(siteRecordOf('')).toEqual({ kind: 'none' })
    for (const bad of ['https://example.com', `ipfs://${CID}/index.html`, 'ipfs://', 'bzz://abcd', `ar://${'A'.repeat(42)}`, 'harbor']) {
      expect(siteRecordOf(bad), bad).toMatchObject({ kind: 'problem', words: expect.stringMatching(/ipfs:\/\//) })
    }
  })
})

describe('optionsOf', () => {
  const want = { label: 'harbor', account: ACCOUNT, facts: facts(), site: { key: 'content.ipfs', text: `ipfs://${CID}` }, tip: { to: TIP_ADDRESS, wei: 500_000_000_000_000n, name: 'orivonstack.eth' } }

  it('plans both ways of holding the name from the same facts, the wrapped one costing more', () => {
    const options = optionsOf(want)
    expect(options.wrapped.steps.map((step) => step.kind)).toEqual(['reserve', 'setController', 'createWrapper', 'transfer', 'wrap', 'record', 'tip'])
    expect(options.unwrapped.steps.map((step) => step.kind)).toEqual(['reserve', 'record', 'tip'])
    expect(options.wrapped.expected).toBeGreaterThan(options.unwrapped.expected)
    expect(options.wrapped.expected).toBe(45_149 + 58_506 + 51_606 + 28_489 + 202_295 + 130_692 + 21_000)
    expect(options.unwrapped.expected).toBe(45_149 + 130_692 + 21_000)
    expect(options.canWrap).toBe(true)
  })

  it('cannot wrap while the wrapper is off, or when its switch cannot be read', () => {
    expect(optionsOf({ ...want, facts: facts({ wrapEnabled: false }) }).canWrap).toBe(false)
    expect(optionsOf({ ...want, facts: facts({ wrapEnabled: null }) }).canWrap).toBe(false)
  })
})

describe('costOf', () => {
  const plan = optionsOf({ label: 'harbor', account: ACCOUNT, facts: facts(), site: null, tip: { to: TIP_ADDRESS, wei: 500_000_000_000_000n, name: 'orivonstack.eth' } }).wrapped

  it('counts the name\'s steps apart from the tip, and prices them at the fee when it is known', () => {
    const cost = costOf(plan, 10_000_000_000n)
    expect(cost.tipWei).toBe(500_000_000_000_000n)
    expect(cost.gas).toBe('about 386,045 gas, at most 600,000')
    expect(cost.ether).toBe('0.00386045 ETH')
  })

  it('has no price when the fee could not be read, and no tip when none is planned', () => {
    expect(costOf(plan, null).ether).toBeNull()
    expect(costOf(optionsOf({ label: 'harbor', account: ACCOUNT, facts: facts(), site: null, tip: null }).wrapped, 1n).tipWei).toBe(0n)
  })
})

describe('panelOf', () => {
  it('is a registration for a free name, with the tip ticked and the choice of how to hold it', () => {
    expect(panelOf('register')).toEqual({ heading: 'Register', button: 'Register', wraps: false, tipTicked: true })
    expect(panelOf(null)).toEqual(panelOf('register'))
  })

  it('is the wrapping of a name the account holds already, which is no registration and asks for no tip until it is ticked', () => {
    expect(panelOf('continue')).toEqual({ heading: 'Wrap', button: 'Wrap it', wraps: true, tipTicked: false })
    expect(panelOf('finish')).toEqual({ heading: 'Finish wrapping', button: 'Finish wrapping', wraps: true, tipTicked: false })
  })

  it('never calls the wrapping of a held name "Finish registering"', () => {
    for (const offer of ['register', 'continue', 'finish', null] as const) expect(JSON.stringify(panelOf(offer))).not.toMatch(/Finish registering/)
  })
})

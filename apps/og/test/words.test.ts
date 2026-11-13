import { describe, expect, it } from 'vitest'
import { bannerOf, stripOf } from '../site/header-model.js'
import { CONFIRM_WORDS, formatEth, formatGas, HOW_STEPS, KEY_WORDS, readName, readThrough, shortAddress } from '../site/words.js'
import { doneWords, outcomeWords } from '../site/register-words.js'
import { manageDoneWords } from '../site/manage-words.js'
import { typingWords } from '../site/search-model.js'
import { TEXT_KEYS } from '../site/resolver/og-pins.js'

describe('readName', () => {
  it('reads a name, with or without .og, in any case of the suffix', () => {
    expect(readName('harbor')).toEqual({ kind: 'name', label: 'harbor' })
    expect(readName(' harbor.og ')).toEqual({ kind: 'name', label: 'harbor' })
    expect(readName('harbor.OG')).toEqual({ kind: 'name', label: 'harbor' })
    expect(readName('')).toEqual({ kind: 'empty' })
    expect(readName('.og')).toEqual({ kind: 'empty' })
  })
  it('gives the name rule\'s refusal in words, one for each reason', () => {
    const words = (text: string) => { const found = readName(text); return found.kind === 'problem' ? found.words : '' }
    expect(words('a.b')).toMatch(/no dots.*no subnames/)
    expect(words('x'.repeat(33))).toMatch(/32 bytes at most and this one is 33/)
    expect(words('Harbor')).toMatch(/Use "harbor"/)
    expect(words('a b')).toMatch(/ENSIP-15/)
  })
})

describe('the spellings', () => {
  it('writes ether with the decimals it needs', () => {
    expect(formatEth(0n)).toBe('0 ETH')
    expect(formatEth(500_000_000_000_000n)).toBe('0.0005 ETH')
    expect(formatEth(10n ** 18n)).toBe('1 ETH')
    expect(formatEth(1n)).toBe('less than 0.00000001 ETH')
  })
  it('writes gas and addresses', () => {
    expect(formatGas(532_374)).toBe('532,374 gas')
    expect(shortAddress(`0x${'ab'.repeat(20)}`)).toBe('0xabab…abab')
  })
  it('has words for every reason the freshness rule gives, and a label for every key the resolver reads', () => {
    expect(Object.keys(KEY_WORDS).sort()).toEqual(['controller-is-not-the-holder', 'latest-log-carries-another-value', 'no-SetTextRecord-log', 'no-holder-change-log', 'passes', 'set-before-the-last-NewController', 'set-before-the-last-holder-change'])
    expect(TEXT_KEYS.length).toBeGreaterThan(0)
  })
})

describe('the bar and the banner', () => {
  it('wears the shield only for a read the person\'s own light client answers', () => {
    expect(stripOf({ kind: 'orivon', reading: 'allowed' }).shield).toBe(true)
    expect(stripOf({ kind: 'orivon', reading: 'unknown' }).shield).toBe(false)
    expect(stripOf({ kind: 'eip1193', reading: 'unknown' }).shield).toBe(false)
    expect(stripOf({ kind: null, reading: 'unknown' }).tone).toBe('warn')
  })
  it('says a registration is under way only once it is, and needs attention only when it stopped after sending something', () => {
    expect(bannerOf({ phase: 'idle' })).toBeNull()
    expect(bannerOf({ phase: 'checking' })).toBeNull()
    expect(bannerOf({ phase: 'running', name: 'harbor.og' })).toMatchObject({ tone: 'info', words: expect.stringMatching(/harbor\.og is in progress/) })
    expect(bannerOf({ phase: 'done' })).toBeNull()
    expect(bannerOf({ phase: 'stopped', name: 'harbor.og', outcome: { at: null, sent: [] } })).toBeNull()
    expect(bannerOf({ phase: 'stopped', name: 'harbor.og', outcome: { at: 'wrap', sent: ['reserve'] } })).toMatchObject({ tone: 'warn' })
  })
})

describe('what the words promise', () => {
  it('says how often the wallet asks, by the way it signs: once for a series, or once for each step', () => {
    expect(CONFIRM_WORDS.series).toMatch(/whole series once/)
    expect(CONFIRM_WORDS.each).toMatch(/each step/)
    expect(CONFIRM_WORDS.unknown).toMatch(/whole series once if it can sign one, and otherwise each step/)
    const register = HOW_STEPS.find((step) => step.title === 'Register')?.words ?? ''
    expect(register).toContain(CONFIRM_WORDS.unknown)
    expect(register).not.toMatch(/never left stranded/)
  })

  it('says of the first page\'s Register line what holds for a wallet that signs a series and for one that signs a step at a time', () => {
    const short = HOW_STEPS.find((step) => step.title === 'Register')?.short ?? ''
    expect(short).toMatch(/together or one by one/)
    expect(short).toMatch(/after the one before it is mined/)
    expect(short).not.toMatch(/confirms the series/)
  })

  it('says plainly that a name waits at the wrapper when wrapping is switched off after it went there', () => {
    const register = HOW_STEPS.find((step) => step.title === 'Register')?.words ?? ''
    expect(register).toMatch(/switched off after the name went to the wrapper, the name waits there/)
    const view = { name: 'harbor.og', steps: [], costs: { feeWei: 0n, tipWei: 0n }, outcome: { kind: 'wrapOffLate', at: 'wrap', hash: null, offer: 'finishWrapping' } }
    const lines = outcomeWords(view).lines.join(' ')
    expect(lines).toMatch(/stuck there/)
    expect(lines).toMatch(/Only the wrapper's owner can switch wrapping on again, and nothing says when/)
    expect(lines).not.toMatch(/Nothing is lost/)
  })

  it('says where a read goes, by the wallet the page was given: an extension\'s provider sees the names it is asked about', () => {
    expect(readThrough('orivon')).toBe('your own node')
    expect(readThrough('eip1193')).toMatch(/wallet extension.*RPC provider.*sees/)
    expect(typingWords('orivon')).toBe('Typing asks no server anything. When you stop, the name is read from Ethereum through your own node.')
    expect(typingWords('eip1193')).toMatch(/RPC provider it uses, which sees/)
    expect(typingWords(null)).toMatch(/your own node/)
  })
})

describe('when a change starts to open in Orivon', () => {
  const costs = { gasUsed: 0, feeWei: 10n ** 15n, tipWei: 0n }
  const step = (kind: string, state = 'done') => ({ kind, state, hash: '0xab' })

  it('tells a registration that wrote a site that Orivon opens it in about 13 minutes, and why', () => {
    const words = doneWords({ name: 'harbor.og', costs, steps: [step('reserve'), step('record')] })
    expect(words.title).toMatch(/^harbor\.og is registered\. It cost /)
    expect(words.title).not.toMatch(/13 minutes/)
    expect(words.lines.join(' ')).toMatch(/Orivon starts to open its site in about 13 minutes/)
    expect(words.lines.join(' ')).toMatch(/can no longer be taken back/)
  })

  it('says nothing about it for a registration that wrote no site, which has nothing to open yet', () => {
    expect(doneWords({ name: 'harbor.og', costs, steps: [step('reserve'), step('record', 'dropped')] }).lines).toEqual([])
    expect(doneWords({ name: 'harbor.og', costs, steps: [step('reserve')] }).lines).toEqual([])
  })

  it('says it after each change that writes or clears a record on the name page, and after none of the others', () => {
    const lines = (action: string) => manageDoneWords({ name: 'harbor.og', action, costs, steps: [step('record')], facts: null, request: {} }).lines.join(' ')
    for (const action of ['setSite', 'reconfirm', 'clear']) expect(lines(action), action).toMatch(/in Orivon's address bar shows this change in about 13 minutes/)
    for (const action of ['setPrimary', 'transfer', 'fixController']) expect(lines(action), action).not.toMatch(/13 minutes/)
  })
})

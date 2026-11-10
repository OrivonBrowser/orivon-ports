import { describe, expect, it } from 'vitest'
import { encode } from '../site/sdk/abi.js'
import { fromHex, toHex } from '../site/sdk/bytes.js'
import { ChainError, REASONS as CHAIN_REASONS, type Reason } from '../site/sdk/chain.js'
import { REASONS, REVERT_REASONS, reasonOfError, revertReason } from '../site/register-reasons.js'
import { RelayError } from '../site/relay.js'

const errorData = (text: string) => fromHex('0x08c379a0' + toHex(encode(['string'], [text])))

describe('the registrar\'s revert strings', () => {
  const PLAN = [
    ['invalid label', 'invalidLabel'], ['resolver only for your own name', 'resolverNotOwn'], ['commitment too new', 'commitmentTooNew'],
    ['commitment too old', 'commitmentTooOld'], ['v1 unreachable', 'v1Unreachable'], ['DAI below $0.80', 'daiBelowFloor'], ['no beneficiary', 'noBeneficiary']
  ]

  it('map, all seven of the plan and the two of DAI, to a named reason with words', () => {
    for (const [text, reason] of PLAN) expect(REVERT_REASONS, text).toContainEqual([text, reason])
    expect(REVERT_REASONS.map(([text]) => text)).toEqual(expect.arrayContaining(['Dai/insufficient-balance', 'Dai/insufficient-allowance']))
    for (const [, reason] of REVERT_REASONS) expect(REASONS[String(reason)]?.words, String(reason)).toBeTruthy()
  })

  it('are read from a node\'s message and from the revert data alike', () => {
    for (const [text, reason] of REVERT_REASONS) {
      expect(reasonOfError(new ChainError('reverted', `execution reverted: ${text}`)), String(text)).toEqual({ reason, detail: `execution reverted: ${text}` })
      expect(reasonOfError(new ChainError('reverted', 'reverted', { revert: errorData(String(text)) })).reason, String(text)).toBe(reason)
    }
    expect(revertReason('Execution Reverted: COMMITMENT TOO NEW')).toBe('commitmentTooNew')
  })

  it('stay a plain revert when the text is none of them', () => {
    expect(reasonOfError(new ChainError('reverted', 'execution reverted'))).toMatchObject({ reason: 'reverted' })
    expect(reasonOfError(new ChainError('reverted', 'x', { revert: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) }))).toMatchObject({ reason: 'reverted' })
  })
})

describe('the other failures', () => {
  it('keep their chain reason, with invalid said as refused', () => {
    for (const reason of CHAIN_REASONS.filter((one) => one !== 'reverted')) {
      const named = reasonOfError(new ChainError(reason as Reason, 'text')).reason
      expect(REASONS[named], reason).toBeDefined()
      expect(named, reason).toBe(reason === 'invalid' ? 'refused' : reason)
    }
  })

  it('turn a relay failure into relayFailed, and anything else into unavailable', () => {
    expect(reasonOfError(new RelayError('rejected', 'nonce too low'))).toEqual({ reason: 'relayFailed', detail: 'nonce too low' })
    expect(reasonOfError(new Error('boom'))).toEqual({ reason: 'unavailable', detail: 'boom' })
    expect(reasonOfError('plain')).toEqual({ reason: 'unavailable', detail: 'plain' })
  })
})

describe('every reason', () => {
  it('says what the person can do, in words', () => {
    for (const [reason, entry] of Object.entries(REASONS)) {
      expect(['edit', 'retry', 'none'], reason).toContain(entry.recover)
      expect(entry.words.length, reason).toBeGreaterThan(10)
      expect(entry.words, reason).not.toMatch(/[^\x20-\x7e]/)
    }
  })
})

import { describe, expect, it } from 'vitest'
import { price } from '../site/sdk/orivonid.js'
import { REASONS } from '../site/register-reasons.js'
import { formatClock, formatDai, formatDuration, formatTime, keyPreview, LABEL_WORDS, priceTable, readName, shortAddress } from '../site/words.js'

const DAI = 10n ** 18n

describe('readName', () => {
  it('says nothing for nothing', () => {
    expect(readName('')).toEqual({ kind: 'empty' })
    expect(readName('   ')).toEqual({ kind: 'empty' })
  })

  it('lowercases and trims what is sold', () => {
    expect(readName('  Alice ')).toEqual({ kind: 'name', label: 'alice' })
  })

  it('names every problem of the registrar\'s rule in words', () => {
    const cases: [string, string][] = [
      ['ab', 'tooShort'], ['a'.repeat(64), 'tooLong'], ['-abc', 'edgeHyphen'], ['abc-', 'edgeHyphen'], ['ab--cd', 'doubleHyphen'],
      ['ab_cd', 'badCharacter'], ['a b c', 'badCharacter'], ['0x' + '1'.repeat(40), 'addressLike']
    ]
    for (const [input, reason] of cases) {
      const found = readName(input)
      expect(found, input).toMatchObject({ kind: 'problem', reason })
      expect((found as { words: string }).words, input).toBe(LABEL_WORDS[reason as keyof typeof LABEL_WORDS])
    }
  })

  it('refuses a non-ASCII letter before it is lowercased, and a reserved name, with the REASONS words', () => {
    expect(readName('Kelvin')).toEqual({ kind: 'problem', reason: 'notAscii', words: REASONS['notAscii']?.words })
    expect(readName('Orivon')).toEqual({ kind: 'problem', reason: 'reserved', words: REASONS['reserved']?.words })
  })

  it('has words for every reason labelProblem can give', () => {
    expect(Object.keys(LABEL_WORDS).sort()).toEqual(['addressLike', 'badCharacter', 'doubleHyphen', 'edgeHyphen', 'tooLong', 'tooShort'])
    for (const words of Object.values(LABEL_WORDS)) expect(words.length).toBeGreaterThan(10)
  })
})

describe('spellings', () => {
  it('shows the registrar\'s three prices', () => {
    expect(priceTable().map((row) => row.wei)).toEqual([800n * DAI, 200n * DAI, 10n * DAI])
    expect(priceTable().map((row) => row.wei)).toEqual([price('abc'), price('abcd'), price('abcde')])
  })

  it('writes DAI with at most two decimals and no trailing zero', () => {
    expect(formatDai(10n * DAI)).toBe('10 DAI')
    expect(formatDai(DAI / 2n)).toBe('0.5 DAI')
    expect(formatDai(52n * DAI + DAI / 4n)).toBe('52.25 DAI')
    expect(formatDai(0n)).toBe('0 DAI')
    expect(formatDai(1n)).toBe('0 DAI')
  })

  it('shortens an address only when it is one, and keeps both ends', () => {
    const address = '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826'
    expect(shortAddress(address)).toBe('0xCD2a…D826')
    expect(shortAddress('alice.v1.orivonid.eth')).toBe('alice.v1.orivonid.eth')
  })

  it('writes a clock, never negative', () => {
    expect(formatClock(42)).toBe('0:42')
    expect(formatClock(60)).toBe('1:00')
    expect(formatClock(61.2)).toBe('1:02')
    expect(formatClock(-5)).toBe('0:00')
  })

  it('writes durations in the largest whole unit', () => {
    expect([60, 600, 3600, 86_400, 604_800, 2_592_000, 15_552_000, 90].map(formatDuration))
      .toEqual(['1 minute', '10 minutes', '1 hour', '1 day', '7 days', '30 days', '180 days', '90 seconds'])
  })

  it('writes a time in UTC', () => {
    expect(formatTime(1_796_558_400)).toBe('6 Dec 2026, 12:00 UTC')
  })

  it('shows a key by its first and last bytes', () => {
    expect(keyPreview('0x037cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978')).toBe('0x037cf27b…47669978')
  })
})

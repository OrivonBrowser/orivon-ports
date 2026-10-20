import { describe, expect, it } from 'vitest'
import { RECORD_WARN_MS, flagWarnings, formatSpan, providersView, recordLife } from '../site/derive.js'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const HOUR = 3_600_000

describe('formatSpan', () => {
  it('uses the largest unit that says something', () => {
    expect(formatSpan(30_000)).toBe('1 min')
    expect(formatSpan(45 * 60_000)).toBe('45 min')
    expect(formatSpan(5 * HOUR + 59 * 60_000)).toBe('5 h')
    expect(formatSpan(3 * 24 * HOUR + 2 * HOUR)).toBe('3 d 2 h')
    expect(formatSpan(4 * 24 * HOUR)).toBe('4 d')
    expect(formatSpan(30 * 24 * HOUR + 5 * HOUR)).toBe('30 d')
  })
})

describe('recordLife', () => {
  it('is ok with more than 24 hours left', () => {
    expect(recordLife(new Date(NOW + 25 * HOUR), NOW)).toMatchObject({ state: 'ok', text: '1 d 1 h left' })
  })

  it('flags a record with under 24 hours left, and not one with exactly 24', () => {
    expect(recordLife(new Date(NOW + 23 * HOUR), NOW)).toMatchObject({ state: 'soon', text: '23 h left' })
    expect(recordLife(new Date(NOW + RECORD_WARN_MS), NOW).state).toBe('ok')
    expect(recordLife(new Date(NOW + RECORD_WARN_MS - 1), NOW).state).toBe('soon')
  })

  it('says a record has ended, and for how long', () => {
    expect(recordLife(new Date(NOW - 2 * HOUR), NOW)).toMatchObject({ state: 'ended', text: 'ended 2 h ago' })
    expect(recordLife(new Date(NOW), NOW).state).toBe('ended')
  })

  it('does not invent an end for a record that gives none', () => {
    expect(recordLife(null, NOW)).toMatchObject({ state: 'open', left: null })
    expect(recordLife(undefined, NOW).state).toBe('open')
  })
})

describe('providersView', () => {
  it('flags exactly one provider, and nobody', () => {
    expect(providersView({ status: 'ok', count: 1 })).toEqual({ text: '1 listed', flag: 'single' })
    expect(providersView({ status: 'ok', count: 0 })).toEqual({ text: 'nobody', flag: 'none' })
  })

  it('does not flag two or more', () => {
    expect(providersView({ status: 'ok', count: 2 })).toEqual({ text: '2 listed', flag: null })
    expect(providersView({ status: 'ok', count: 40 }).flag).toBeNull()
  })

  it('does not flag a count that was never obtained', () => {
    for (const status of ['pending', 'skipped', 'error']) expect(providersView({ status, count: 0 }).flag).toBeNull()
  })
})

describe('flagWarnings', () => {
  const row = (count: number, expires: Date | null | undefined, best = true) => ({
    providers: { status: 'ok', count },
    record: { best: best ? { expires } : null }
  })

  it('names a single provider and a record ending within a day, in that order', () => {
    expect(flagWarnings(row(1, new Date(NOW + 2 * HOUR)), NOW)).toEqual([
      'Only one provider announces this content',
      'The ipns:// record is valid for less than 24 hours (2 h left)'
    ])
  })

  it('says nothing about a healthy row, an ended record (the verdict already says it) or a missing one', () => {
    expect(flagWarnings(row(3, new Date(NOW + 48 * HOUR)), NOW)).toEqual([])
    expect(flagWarnings(row(3, new Date(NOW - HOUR)), NOW)).toEqual([])
    expect(flagWarnings(row(3, null, false), NOW)).toEqual([])
  })
})

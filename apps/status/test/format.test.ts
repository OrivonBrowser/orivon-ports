import { describe, expect, it } from 'vitest'
import { formatBytes, formatClock, formatDate, formatGateways, formatSeconds } from '../site/format.js'

describe('format', () => {
  it('writes sizes in decimal units', () => {
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1500)).toBe('1.5 KB')
    expect(formatBytes(163525797)).toBe('164 MB')
    expect(formatBytes(2_500_000_000)).toBe('2.5 GB')
  })

  it('writes seconds with a decimal under ten', () => {
    expect(formatSeconds(860)).toBe('0.9 s')
    expect(formatSeconds(12_400)).toBe('12 s')
  })

  it('writes dates in UTC and the clock in local time', () => {
    expect(formatDate(new Date('2026-10-21T13:42:51.990Z'))).toBe('2026-10-21 13:42 UTC')
    expect(formatClock(new Date(2026, 9, 19, 7, 5, 9))).toBe('07:05:09')
  })

  it('lists gateways by how many blocks each served', () => {
    expect(formatGateways({ 'a.example': 1, 'b.example': 6 })).toBe('b.example ×6, a.example ×1')
  })
})

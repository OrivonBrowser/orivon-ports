import { describe, expect, it } from 'vitest'
import { artOf, CARD, emWidth, isRightToLeft, splitLabel } from '../site/art-model.js'

describe('the card of a name', () => {
  it('is the same for the same label, and different for another one or for wrapped and not', () => {
    expect(artOf({ label: 'harbor', wrapped: true })).toEqual(artOf({ label: 'harbor', wrapped: true }))
    expect(artOf({ label: 'harbor', wrapped: true }).hue).not.toBe(artOf({ label: 'harbour', wrapped: true }).hue)
    expect(artOf({ label: 'harbor', wrapped: true }).caption).toBe('Wrapped')
    expect(artOf({ label: 'harbor', wrapped: false }).caption).toBe('Not wrapped')
    expect(artOf({ label: 'harbor', wrapped: false }).title).toBe('harbor.og, not wrapped')
  })

  it('draws a short label on one line at the largest size', () => {
    const art = artOf({ label: 'og', wrapped: true })
    expect(art.lines.map((line) => line.text)).toEqual(['og'])
    expect(art.fontSize).toBe(64)
  })

  it('keeps every label from one letter to 32 bytes, in any script, inside the card and large enough to read', () => {
    const labels = ['a', 'harbor', 'abcdefghijklmnopqrstuvwxyz012345', 'a-very-long-name-with-hyphens-in-it', 'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww', '日本語日本語日本語', 'ｆｕｌｌｗｉｄｔｈ', 'مرحبا-بالعالم', 'नमस्तेनमस्तेनमस्ते', '😀😀😀😀😀😀😀😀', 'iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii']
    for (const label of labels) {
      const art = artOf({ label, wrapped: true })
      const widest = Math.max(...art.lines.map((line) => emWidth(line.text) * art.fontSize))
      expect(widest, label).toBeLessThanOrEqual(CARD.size - 2 * CARD.margin + 0.5)
      expect(art.fontSize, label).toBeGreaterThanOrEqual(18)
      expect(art.lines.length, label).toBeLessThanOrEqual(3)
      expect(art.lines.map((line) => line.text).join(''), label).toBe(label)
      for (const line of art.lines) expect(line.y, label).toBeLessThan(art.suffix.y)
      expect(art.suffix.y, label).toBeLessThan(CARD.size - 40)
    }
  })

  it('splits a long label at a hyphen near the middle, and in balanced halves otherwise', () => {
    expect(splitLabel('harbor-light-house-keeper', 2)).toEqual(['harbor-light-', 'house-keeper'])
    expect(splitLabel('abcdefgh', 2)).toEqual(['abcd', 'efgh'])
    expect(splitLabel('ab', 3)).toEqual(['ab'])
  })

  it('knows a right-to-left label', () => {
    expect(isRightToLeft('مرحبا')).toBe(true)
    expect(isRightToLeft('שלום')).toBe(true)
    expect(isRightToLeft('harbor')).toBe(false)
    expect(artOf({ label: 'مرحبا', wrapped: false }).rtl).toBe(true)
  })
})

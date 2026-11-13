// The card a name is drawn on, as data: where its lines go and how large they are, so that a label of one letter and one of thirty-two
// bytes in any script stay on the card. Pure and local: the colours come from the label itself, and nothing is fetched. art.js turns the
// description into SVG.

import { utf8 } from './sdk/bytes.js'

export const CARD = Object.freeze({ size: 320, margin: 24 })
/** The widest a line of the label may be. */
const WIDTH = CARD.size - 2 * CARD.margin
/** The sizes a line may take: a single line this large or larger stays one line; below it the label is split; below the least, it takes three. */
const SIZES = Object.freeze({ most: 64, comfortable: 30, least: 22 })

/** How wide a character is, in ems, as a font of this kind draws it. Estimated, and on the wide side, so a line is never wider than it is said to be. @param {string} char */
function emOf (char) {
  const code = char.codePointAt(0) ?? 0
  if ((code >= 0x1100 && code <= 0x11ff) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) || code >= 0x1f000) return 1.05
  if (code >= 0x0e00 && code <= 0x0eff) return 0.75
  if (code >= 0x0900 && code <= 0x0dff) return 0.8
  if (code >= 0x0590 && code <= 0x08ff) return 0.68
  if (code > 0x7f) return 0.72
  if ('ijl1!|.,\'`:;'.includes(char)) return 0.36
  if (char === '-' || char === '_') return 0.46
  if ('mw'.includes(char)) return 0.92
  return 0.62
}

/** @param {string} text */
export const emWidth = (text) => [...text].reduce((sum, char) => sum + emOf(char), 0)

/** @param {string} label @returns {boolean} */
export const isRightToLeft = (label) => /[֐-ࣿיִ-﷿ﹰ-﻿]/.test(label)

/**
 * The label cut into `count` lines of about the same width, at a hyphen when one is near the cut.
 * @param {string} label
 * @param {number} count
 * @returns {string[]}
 */
export function splitLabel (label, count) {
  const chars = [...label]
  if (count <= 1 || chars.length <= count) return [label]
  const total = emWidth(label)
  /** @type {string[]} */
  const lines = []
  let start = 0
  for (let line = 1; line < count; line++) {
    const target = (total * line) / count
    let width = emWidth(chars.slice(0, start).join(''))
    let cut = start
    let best = -1
    while (cut < chars.length - 1 && width < target) {
      width += emOf(chars[cut] ?? '')
      cut++
      if (chars[cut - 1] === '-' && Math.abs(width - target) <= 2.2) best = cut
    }
    const end = Math.max(start + 1, best === -1 ? cut : best)
    lines.push(chars.slice(start, end).join(''))
    start = end
  }
  lines.push(chars.slice(start).join(''))
  return lines.filter((line) => line !== '')
}

/** A number from the label's bytes, the same on every device. @param {string} label */
function seedOf (label) {
  let hash = 0x811c9dc5
  for (const byte of utf8(label)) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0 }
  return hash
}

/**
 * @param {{ label: string, wrapped: boolean }} name
 * @returns {{
 *   size: number, hue: number, lines: { text: string, y: number }[], fontSize: number, suffix: { text: string, y: number, fontSize: number },
 *   caption: string, wrapped: boolean, rtl: boolean, shapes: { x: number, y: number, r: number }[], title: string
 * }}
 */
export function artOf ({ label, wrapped }) {
  const seed = seedOf(label)
  const hue = seed % 360
  let lines = [label]
  let fontSize = Math.min(SIZES.most, WIDTH / Math.max(1, emWidth(label)))
  if (fontSize < SIZES.comfortable) {
    lines = splitLabel(label, 2)
    fontSize = Math.min(48, WIDTH / Math.max(...lines.map(emWidth)))
    if (fontSize < SIZES.least) {
      lines = splitLabel(label, 3)
      fontSize = Math.min(38, WIDTH / Math.max(...lines.map(emWidth)))
    }
  }
  fontSize = Math.floor(fontSize * 10) / 10
  const gap = fontSize * 1.18
  const block = gap * (lines.length - 1)
  const top = CARD.size * 0.44 - block / 2
  const suffixSize = Math.max(18, Math.min(30, fontSize * 0.5))
  return {
    size: CARD.size, hue, fontSize, rtl: isRightToLeft(label), wrapped,
    lines: lines.map((text, index) => ({ text, y: Math.round((top + gap * index + fontSize * 0.34) * 10) / 10 })),
    suffix: { text: '.og', y: Math.round((top + block + fontSize * 0.34 + suffixSize * 1.3) * 10) / 10, fontSize: suffixSize },
    caption: wrapped ? 'Wrapped' : 'Not wrapped',
    shapes: [0, 1, 2].map((index) => ({
      x: 40 + ((seed >>> (index * 8)) & 0xff) * 0.9, y: 40 + ((seed >>> (index * 5 + 3)) & 0xff) * 0.9, r: 60 + (((seed >>> (index * 3)) & 0x3f) * 1.5)
    })),
    title: `${label}.og, ${wrapped ? 'wrapped' : 'not wrapped'}`
  }
}

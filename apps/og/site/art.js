// A name's card as SVG, built node by node from art-model.js's description: no markup string, no image, no font file and no request.
// The text is the label itself, so a screen reader reads it; the shapes are decoration.

import { artOf } from './art-model.js'
import { svgNode as node } from './icons.js'

const FONT = 'system-ui, -apple-system, "Segoe UI", "Noto Sans", "Noto Sans CJK SC", "Noto Sans Arabic", "Noto Sans Devanagari", sans-serif'
const INK = '#f5f7fb'
const SOFT = 'rgba(245, 247, 251, 0.78)'

let counter = 0

/**
 * @param {{ label: string, wrapped: boolean }} name
 * @param {{ class?: string }} [options]
 * @returns {SVGSVGElement}
 */
export function nameArt (name, options = {}) {
  const art = artOf(name)
  const { size } = art
  const svg = /** @type {SVGSVGElement} */ (node('svg', {
    viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': art.title, class: options.class ?? 'name-art-svg', focusable: 'false'
  }))
  const gradient = `art-${counter++}`
  svg.append(
    node('defs', {},
      node('linearGradient', { id: gradient, x1: 0, y1: 0, x2: 1, y2: 1 },
        node('stop', { offset: 0, 'stop-color': `hsl(${art.hue} 48% 24%)` }),
        node('stop', { offset: 1, 'stop-color': `hsl(${(art.hue + 48) % 360} 52% 12%)` }))),
    node('rect', { width: size, height: size, rx: 22, fill: `url(#${gradient})` }),
    ...art.shapes.map((shape) => node('circle', { cx: shape.x, cy: shape.y, r: shape.r, fill: 'none', stroke: 'rgba(255, 255, 255, 0.08)', 'stroke-width': 14 })),
    node('rect', {
      x: 10, y: 10, width: size - 20, height: size - 20, rx: 16, fill: 'none', stroke: art.wrapped ? 'rgba(255, 255, 255, 0.55)' : 'rgba(255, 255, 255, 0.4)',
      'stroke-width': art.wrapped ? 3 : 2, ...(art.wrapped ? {} : { 'stroke-dasharray': '7 7' })
    }),
    ...art.lines.map((line) => node('text', {
      x: size / 2, y: line.y, 'text-anchor': 'middle', fill: INK, 'font-family': FONT, 'font-size': art.fontSize, 'font-weight': 650, direction: art.rtl ? 'rtl' : 'ltr'
    }, line.text)),
    node('text', { x: size / 2, y: art.suffix.y, 'text-anchor': 'middle', fill: SOFT, 'font-family': FONT, 'font-size': art.suffix.fontSize, 'font-weight': 500 }, art.suffix.text),
    node('text', { x: size / 2, y: size - 28, 'text-anchor': 'middle', fill: SOFT, 'font-family': FONT, 'font-size': 15, 'letter-spacing': 1.5 }, art.caption.toUpperCase()))
  return svg
}

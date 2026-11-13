// A name's card as SVG, built node by node from art-model.js's description: no markup string, no image and no request. The night sky takes
// its tint from the label, the clouds and the strip of meadow are drawn in pixels, and the text is the label itself, so a screen reader
// reads it; the shapes are decoration.

import { artOf } from './art-model.js'
import { svgNode as node } from './icons.js'

const FONT = '"Bricolage Grotesque", system-ui, -apple-system, "Segoe UI", "Noto Sans", "Noto Sans CJK SC", "Noto Sans Arabic", "Noto Sans Devanagari", sans-serif'
const INK = '#eef0ff'
const SOFT = '#c1b5ff'
const WRAPPED = '#8b6cf5'
/** The meadow's rows, from the edge the moon lights down to the ground, in the page's own blues. */
const GRASS = ['#3a47a6', '#273282', '#1c2563', '#121850']
const PIXEL = 8
const GROUND = 252

let counter = 0

/** A cloud of three rows of pixels, its top left corner at `x`, `y`. @param {number} x @param {number} y @param {number} scale */
function cloud (x, y, scale) {
  const unit = PIXEL * scale
  return [[2, 0, 4], [0, 1, 8], [1, 2, 6]].map(([column, row, wide]) => node('rect', {
    x: x + (column ?? 0) * unit, y: y + (row ?? 0) * unit, width: (wide ?? 1) * unit, height: unit, fill: '#8494e4', 'fill-opacity': 0.3
  }))
}

/** The meadow: a stepped edge of grass over darker rows, its steps taken from the label's own number. @param {number} size @param {{ x: number }[]} steps */
function meadow (size, steps) {
  const columns = size / (PIXEL * 2)
  const rects = []
  for (let column = 0; column < columns; column++) {
    const rise = Math.round((steps[column % steps.length]?.x ?? 0) / 40) % 3
    const top = GROUND - rise * PIXEL
    rects.push(node('rect', { x: column * PIXEL * 2, y: top, width: PIXEL * 2, height: PIXEL, fill: GRASS[0] }))
    rects.push(node('rect', { x: column * PIXEL * 2, y: top + PIXEL, width: PIXEL * 2, height: GROUND + PIXEL * 2 - top - PIXEL, fill: GRASS[1] }))
  }
  rects.push(node('rect', { x: 0, y: GROUND + PIXEL * 2, width: size, height: PIXEL * 2, fill: GRASS[2] }))
  rects.push(node('rect', { x: 0, y: GROUND + PIXEL * 4, width: size, height: size - GROUND - PIXEL * 4, fill: GRASS[3] }))
  return rects
}

/**
 * @param {{ label: string, wrapped: boolean }} name
 * @param {{ class?: string }} [options]
 * @returns {SVGSVGElement}
 */
export function nameArt (name, options = {}) {
  const art = artOf(name)
  const { size } = art
  const svg = /** @type {SVGSVGElement} */ (node('svg', {
    viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': art.title, class: options.class ?? 'name-art-svg', focusable: 'false', 'shape-rendering': 'crispEdges'
  }))
  const id = `art-${counter++}`
  const [first, second] = art.shapes
  // The tint stays in the blues and violets of the page: a label's number picks a place between blue and magenta.
  const hue = 210 + (art.hue % 110)
  svg.append(
    node('defs', {},
      node('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 },
        node('stop', { offset: 0, 'stop-color': `hsl(${hue} 62% 11%)` }),
        node('stop', { offset: 1, 'stop-color': `hsl(${hue + 18} 58% 30%)` })),
      node('clipPath', { id: `${id}-clip` }, node('rect', { width: size, height: size, rx: 22 }))),
    node('g', { 'clip-path': `url(#${id}-clip)` },
      node('rect', { width: size, height: size, fill: `url(#${id})` }),
      ...cloud(24 + ((first?.x ?? 0) % 120), 22 + ((first?.y ?? 0) % 40), 1),
      ...cloud(170 + ((second?.x ?? 0) % 90), 52 + ((second?.y ?? 0) % 30), 0.75),
      ...meadow(size, art.shapes)),
    node('rect', {
      x: 8, y: 8, width: size - 16, height: size - 16, rx: 16, fill: 'none', stroke: art.wrapped ? WRAPPED : 'rgba(238, 240, 255, 0.5)',
      'stroke-width': art.wrapped ? 4 : 2, 'shape-rendering': 'geometricPrecision', ...(art.wrapped ? {} : { 'stroke-dasharray': '7 7' })
    }),
    ...art.lines.map((line) => node('text', {
      x: size / 2, y: line.y, 'text-anchor': 'middle', fill: INK, 'font-family': FONT, 'font-size': art.fontSize, 'font-weight': 800, direction: art.rtl ? 'rtl' : 'ltr'
    }, line.text)),
    node('text', { x: size / 2, y: art.suffix.y, 'text-anchor': 'middle', fill: SOFT, 'font-family': FONT, 'font-size': art.suffix.fontSize, 'font-weight': 800 }, art.suffix.text),
    node('text', { x: size / 2, y: size - 22, 'text-anchor': 'middle', fill: INK, 'font-family': FONT, 'font-size': 15, 'font-weight': 700, 'letter-spacing': 1.5 }, art.caption.toUpperCase()))
  return svg
}

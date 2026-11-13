// The few icons the page draws, as inline SVG built from paths. They carry no meaning alone: a word always sits beside them.

const SVG = 'http://www.w3.org/2000/svg'

/** Path data on a 24 by 24 grid, drawn with a 2px round stroke. */
const PATHS = Object.freeze({
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  alert: ['M12 4l9 16H3z', 'M12 10v4', 'M12 17.5v.01'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 11v5', 'M12 7.5v.01'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
  shield: ['M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z'],
  lock: ['M6 11h12v9H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  key: ['M14 10a4 4 0 1 0-3.5 4L11 15h2v2h2v2h3v-3.5L13.8 11.3A4 4 0 0 0 14 10z'],
  user: ['M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M4.5 20c.8-3.5 3.8-5.5 7.5-5.5s6.7 2 7.5 5.5'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4-4'],
  wallet: ['M4 7h14a2 2 0 0 1 2 2v9H6a2 2 0 0 1-2-2z', 'M4 7l11-3v3', 'M16 13.5h.01'],
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
  external: ['M14 5h5v5', 'M19 5l-8 8', 'M17 14v5H5V7h5'],
  tag: ['M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z', 'M7.5 7.5h.01'],
  card: ['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M9 10.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M5.8 17c.4-1.6 1.7-2.5 3.2-2.5s2.8.9 3.2 2.5', 'M15 9h3', 'M15 13h3'],
  code: ['M8 7l-5 5 5 5', 'M16 7l5 5-5 5', 'M14 4l-4 16'],
  copy: ['M9 9h11v11H9z', 'M5 15V4h11'],
  chevron: ['M9 6l6 6-6 6'],
  layers: ['M12 3l9 5-9 5-9-5z', 'M3 12.5l9 5 9-5', 'M3 17l9 5 9-5'],
  note: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'],
  link: ['M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1 1', 'M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1-1'],
  server: ['M5 4h14v6H5z', 'M5 14h14v6H5z', 'M8.5 7h.01', 'M8.5 17h.01'],
  shieldCheck: ['M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z', 'M9 12l2.2 2.2L15.5 10'],
  globe: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z']
})

/**
 * @param {keyof typeof PATHS} name
 * @param {{ class?: string, size?: number }} [options]
 * @returns {SVGSVGElement}
 */
export function icon (name, options = {}) {
  const svg = document.createElementNS(SVG, 'svg')
  const size = String(options.size ?? 18)
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: `icon${options.class === undefined ? '' : ` ${options.class}`}`
  })) svg.setAttribute(key, value)
  for (const data of PATHS[name]) {
    const path = document.createElementNS(SVG, 'path')
    path.setAttribute('d', data)
    svg.append(path)
  }
  return svg
}

/**
 * A ring that fills as a wait runs out: a track and an arc, both circles of 100 units round, so the arc's length is a
 * percentage. `set(fraction)` fills it from 0 to 1.
 * @param {number} size
 * @returns {{ svg: SVGSVGElement, set: (fraction: number) => void }}
 */
export function ring (size) {
  const svg = document.createElementNS(SVG, 'svg')
  const attributes = { viewBox: '0 0 100 100', width: String(size), height: String(size), 'aria-hidden': 'true', focusable: 'false', class: 'ring' }
  for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value)
  /** @param {string} kind */
  const circle = (kind) => {
    const node = document.createElementNS(SVG, 'circle')
    for (const [key, value] of Object.entries({ cx: '50', cy: '50', r: '44', fill: 'none', 'stroke-width': '7', pathLength: '100', class: kind })) node.setAttribute(key, value)
    svg.append(node)
    return node
  }
  circle('ring-track')
  const arc = circle('ring-arc')
  arc.setAttribute('stroke-linecap', 'round')
  arc.setAttribute('stroke-dasharray', '100 100')
  /** @param {number} fraction */
  const set = (fraction) => { arc.setAttribute('stroke-dashoffset', String(100 - Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 10)) }
  set(0)
  return { svg, set }
}

/** A ring that turns while something is being waited for. */
export function spinner () {
  const span = document.createElement('span')
  span.className = 'spinner'
  span.setAttribute('aria-hidden', 'true')
  return span
}

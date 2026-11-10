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
  external: ['M14 5h5v5', 'M19 5l-8 8', 'M17 14v5H5V7h5']
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

/** A ring that turns while something is being waited for. */
export function spinner () {
  const span = document.createElement('span')
  span.className = 'spinner'
  span.setAttribute('aria-hidden', 'true')
  return span
}

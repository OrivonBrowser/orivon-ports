import { s } from './dom.js'

const PATHS = {
  article: ['M6 3h9l4 4v14H6z', 'M14 3v5h5', 'M9 12h7M9 15h7M9 18h4'],
  picture: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15 9.5h.01'],
  file: ['M8 3h8l3 3v11H8z', 'M5 7v14h11', 'M11 10h5M11 13h5'],
  folder: ['M3 6h7l2 2h9v11H3z', 'M3 10h18'],
  website: ['M3 4h18v16H3z', 'M3 8h18', 'M6 6h.01M9 6h.01', 'M8 14l-2 2 2 2M16 14l2 2-2 2M13 13l-2 6']
}

/** A 24 px line icon that takes its colour from the text. */
export function kindIcon (kind) {
  const svg = s('svg', {
    viewBox: '0 0 24 24',
    width: 20,
    height: 20,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.6,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false'
  })
  for (const d of PATHS[kind] || PATHS.file) svg.append(s('path', { d }))
  return svg
}

import { s } from './dom.js'

const NODES = [
  { x: 16, label: 'You' },
  { x: 84, label: 'Guard' },
  { x: 152, label: 'Middle' },
  { x: 220, label: 'Exit' }
]

/** Three hops that fill left to right as Tor connects. Decorative: the progress bar says the same. */
export function createCircuit () {
  const svg = s('svg', { viewBox: '0 0 236 52', class: 'circuit', 'aria-hidden': 'true', focusable: 'false' })
  const fills = []
  const nodes = []
  for (let i = 0; i < NODES.length - 1; i++) {
    const a = NODES[i].x
    const b = NODES[i + 1].x
    svg.append(s('line', { x1: a + 6, x2: b - 6, y1: 18, y2: 18, class: 'link' }))
    const fill = s('line', { x1: a + 6, x2: b - 6, y1: 18, y2: 18, class: 'fill', pathLength: 1 })
    fills.push(fill)
    svg.append(fill)
  }
  for (const node of NODES) {
    const dot = s('circle', { cx: node.x, cy: 18, r: 5, class: 'node' })
    nodes.push(dot)
    svg.append(dot, s('text', { x: node.x, y: 43, 'text-anchor': 'middle' }, node.label))
  }

  function update (frac, ready) {
    const clamped = Math.min(1, Math.max(0, Number(frac) || 0))
    fills.forEach((fill, i) => {
      const part = Math.min(1, Math.max(0, clamped * fills.length - i))
      fill.setAttribute('stroke-dasharray', '1')
      fill.setAttribute('stroke-dashoffset', String(1 - part))
    })
    nodes.forEach((dot, i) => {
      dot.classList.toggle('lit', i === 0 || clamped * fills.length >= i)
    })
    svg.classList.toggle('live', Boolean(ready))
  }
  update(0, false)
  return { el: svg, update }
}

// The contrast of what is not text, as the page is drawn (WCAG 1.4.11: 3 to 1). A control is found by its edge: the line that bounds it, or
// its fill, whichever stands out from what is behind it. The search field, the radio cards and their dots, the switches (in both positions)
// and the buttons that carry the main action are measured, and so is the focus ring of each: the ring's colour against what is beside it, the
// gap and the control on one side, the page on the other. Both are read from pixels, in the way shoot-contrast.mjs reads text.
// `CONTRAST_REPORT=1` prints every figure, not only the failures.

import { HIDE_TEXT, settle, steady } from './shoot-contrast.mjs'

const NEED = 3

/** The controls whose focus ring is measured: what to focus, and which element draws the ring. */
const FOCUS = [
  { name: 'search field', focus: '.finder-field input:not(:disabled):visible', owner: 'closest:.finder-field' },
  { name: 'name field', focus: '.name-field input:not(:disabled):visible', owner: 'closest:.name-field' },
  { name: 'text field', focus: '.panel input[type="text"]:not(:disabled):visible', owner: 'self' },
  { name: 'radio card', focus: '.pick input:not(:disabled):visible', owner: 'next' },
  { name: 'switch', focus: '.switch input:not(:disabled):visible', owner: 'next' },
  { name: 'search button', focus: '.finder-go:not(:disabled):visible', owner: 'self' },
  { name: 'main button', focus: '.button.primary:not(:disabled):visible', owner: 'self' }
]

/**
 * In the page: the controls to measure, each as a name and a box in page coordinates. `switchesOnly`: nothing but the switches.
 * @param {boolean} switchesOnly
 */
function controls (switchesOnly) {
  const found = []
  const shown = (/** @type {Element} */ one) => {
    for (let at = /** @type {Element | null} */ (one); at !== null; at = at.parentElement) {
      const style = getComputedStyle(at)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      if (at instanceof HTMLDetailsElement && !at.open && at.querySelector(':scope > summary')?.contains(one) !== true) return false
    }
    return one.getClientRects().length > 0
  }
  const add = (/** @type {string} */ name, /** @type {{ left: number, top: number, width: number, height: number }} */ rect) => {
    found.push({ name, box: [rect.left + scrollX, rect.top + scrollY, rect.width, rect.height], ring: null })
  }
  for (const input of document.querySelectorAll('.switch input')) {
    if (!(input instanceof HTMLInputElement) || input.disabled || !shown(input)) continue
    const track = input.nextElementSibling
    if (track !== null) add(`switch ${input.checked ? 'on' : 'off'}`, track.getBoundingClientRect())
  }
  if (switchesOnly) return found
  for (const input of document.querySelectorAll('input[type="text"]')) {
    if (!(input instanceof HTMLInputElement) || input.disabled || !shown(input)) continue
    const pill = input.closest('.finder-field, .name-field')
    add(pill === null ? 'text field' : pill.matches('.finder-field') ? 'search field' : 'name field', (pill ?? input).getBoundingClientRect())
  }
  for (const input of document.querySelectorAll('.pick input[type="radio"]')) {
    const card = input.nextElementSibling
    if (!(input instanceof HTMLInputElement) || input.disabled || card === null || !shown(input)) continue
    const rect = card.getBoundingClientRect()
    add('radio card', rect)
    const dot = getComputedStyle(card, '::before')
    add('radio dot', { left: rect.left + parseFloat(dot.left), top: rect.top + parseFloat(dot.top), width: parseFloat(dot.width), height: parseFloat(dot.height) })
  }
  for (const button of document.querySelectorAll('.button.primary, .finder-go')) {
    if (button instanceof HTMLButtonElement && !button.disabled && shown(button)) add('main button', button.getBoundingClientRect())
  }
  return found
}

/** In the page: puts each switch in the other position, and says how many there were. Called twice, it puts them back. */
function flipSwitches () {
  let count = 0
  for (const input of document.querySelectorAll('.switch input')) {
    if (!(input instanceof HTMLInputElement) || input.disabled || input.getClientRects().length === 0) continue
    input.checked = !input.checked
    count++
  }
  return count
}

/**
 * In the page: the focus ring of the element a spec names, once it is focused: where its box is, and the ring's colour and the distances from the
 * box's edge it covers (negative is inside), read from the outline, else from the first shadow with no blur and some spread.
 * @param {{ owner: string }} spec
 */
function ringOf (spec) {
  const target = document.activeElement
  if (target === null || !target.matches(':focus-visible')) return { reason: 'the keyboard did not give it a focus ring' }
  const owner = spec.owner === 'self' ? target : spec.owner === 'next' ? target.nextElementSibling : target.closest(spec.owner.slice('closest:'.length))
  if (owner === null) return { reason: 'no element draws its ring' }
  const style = getComputedStyle(owner)
  const rect = owner.getBoundingClientRect()
  const box = [rect.left + scrollX, rect.top + scrollY, rect.width, rect.height]
  const channels = (/** @type {string} */ text) => (text.match(/[\d.]+/g) ?? []).map(Number)
  if (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) {
    const offset = parseFloat(style.outlineOffset)
    return { box, ring: { color: channels(style.outlineColor), from: offset, to: offset + parseFloat(style.outlineWidth) } }
  }
  for (const shadow of style.boxShadow === 'none' ? [] : style.boxShadow.split(/,(?![^(]*\))/)) {
    const color = shadow.match(/(?:rgba?|color)\([^)]*\)/)?.[0] ?? ''
    const [x = 0, y = 0, blur = 1, spread = 0] = shadow.replace(color, '').replace('inset', '').trim().split(/\s+/).map(parseFloat)
    if (x !== 0 || y !== 0 || blur !== 0 || spread <= 0) continue
    return { box, ring: { color: channels(color), from: shadow.includes('inset') ? -spread : 0, to: shadow.includes('inset') ? 0 : spread } }
  }
  return { reason: 'it has no outline and no ring of box-shadow' }
}

/**
 * In the page: for each job, the lowest contrast on its four sides and where it is, or null when no side has pixels. A job with no ring is a control's edge:
 * the better of its line and its fill against what is just outside. A job with a ring is its focus ring against what is just inside and just
 * outside it.
 * @param {{ png: string, origin: number[], jobs: { box: number[], ring: { color: number[], from: number, to: number } | null }[] }} given
 */
async function judge ({ png, origin, jobs }) {
  const picture = new Image()
  await new Promise((done, fail) => { picture.onload = done; picture.onerror = fail; picture.src = `data:image/png;base64,${png}` })
  const canvas = document.createElement('canvas')
  canvas.width = picture.width
  canvas.height = picture.height
  const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }))
  context.drawImage(picture, 0, 0)
  const linear = (/** @type {number} */ value) => { const unit = value / 255; return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4 }
  const luminance = (/** @type {number[]} */ rgb) => 0.2126 * linear(rgb[0] ?? 0) + 0.7152 * linear(rgb[1] ?? 0) + 0.0722 * linear(rgb[2] ?? 0)
  const contrast = (/** @type {number[]} */ one, /** @type {number[]} */ other) => {
    const [light = 0, dark = 0] = [luminance(one), luminance(other)].sort((a, b) => b - a)
    return (light + 0.05) / (dark + 0.05)
  }
  /** The mean colour of the band between two distances from a box's edge (negative is inside), along the middle of that side, a sixteenth of its length (a pill's end curves away from its box at once, so a long strip would read the page beside it). */
  const colour = (/** @type {number[]} */ box, /** @type {string} */ side, /** @type {number} */ from, /** @type {number} */ to) => {
    const [x = 0, y = 0, w = 0, h = 0] = box
    const flat = side === 'top' || side === 'bottom'
    const span = Math.max(3, Math.min((flat ? w : h) / 16, 40))
    const along = (flat ? x + w / 2 : y + h / 2) - span / 2
    const thick = Math.max(1, Math.round(to - from))
    const across = side === 'top' ? y - to : side === 'left' ? x - to : side === 'bottom' ? y + h + from : x + w + from
    const [rx, ry, rw, rh] = flat ? [along, across, span, thick] : [across, along, thick, span]
    const left = Math.max(0, Math.round(rx))
    const top = Math.max(0, Math.round(ry))
    const width = Math.min(Math.max(1, Math.round(rw)), picture.width - left)
    const height = Math.min(Math.max(1, Math.round(rh)), picture.height - top)
    if (width < 1 || height < 1) return null
    const data = context.getImageData(left, top, width, height).data
    const sum = [0, 0, 0]
    for (let at = 0; at < data.length; at += 4) for (let channel = 0; channel < 3; channel++) sum[channel] = (sum[channel] ?? 0) + (data[at + channel] ?? 0)
    return sum.map((total) => total / (data.length / 4))
  }
  return jobs.map((job) => {
    const box = [(job.box[0] ?? 0) - (origin[0] ?? 0), (job.box[1] ?? 0) - (origin[1] ?? 0), job.box[2] ?? 0, job.box[3] ?? 0]
    let worst = Infinity
    let where = ''
    for (const side of ['top', 'right', 'bottom', 'left']) {
      if (job.ring === null) {
        const outside = colour(box, side, 4, 7)
        const fill = colour(box, side, -7, -4)
        if (outside === null || fill === null) continue
        let best = contrast(fill, outside)
        for (const [from, to] of [[-3, -2], [-2, -1], [-1, 0], [0, 1], [1, 2], [2, 3]]) {
          const line = colour(box, side, from ?? 0, to ?? 0)
          if (line !== null) best = Math.max(best, contrast(line, outside))
        }
        if (best < worst) { worst = best; where = `${side}, against rgb(${outside.map(Math.round).join(',')})` }
      } else {
        const { color, from, to } = job.ring
        const alpha = color[3] ?? 1
        const nears = { inside: colour(box, side, from - 3, from - 1), outside: colour(box, side, to + 1, to + 3) }
        for (const [place, near] of Object.entries(nears)) {
          if (near === null) continue
          const ratio = contrast([0, 1, 2].map((channel) => (color[channel] ?? 0) * alpha + (near[channel] ?? 0) * (1 - alpha)), near)
          if (ratio < worst) { worst = ratio; where = `${side}, ${place} the ring, against rgb(${near.map(Math.round).join(',')})` }
        }
      }
    }
    return worst === Infinity ? null : { ratio: worst, where }
  })
}

/**
 * The controls on the page whose edge, or whose focus ring, is under 3 to 1, as problem lines. It leaves the page as it found it, with the
 * switches back where they were and nothing focused.
 * @param {import('playwright-core').Page} page
 * @param {string} here
 * @returns {Promise<string[]>}
 */
export async function controlProblems (page, here) {
  const problems = []
  const worst = new Map()
  const note = (/** @type {string} */ kind, /** @type {string} */ name, /** @type {{ ratio: number, where: string } | null} */ found, /** @type {number[]} */ box) => {
    if (found === null) return
    if (process.env['CONTRAST_REPORT'] === '1') console.error(`${here}: ${kind} of ${name}: ${found.ratio.toFixed(2)} to 1 (${found.where})`)
    const key = `${kind} of ${name}`
    if (found.ratio < NEED && (!worst.has(key) || (worst.get(key)?.ratio ?? 0) > found.ratio)) worst.set(key, { ...found, box })
  }
  const hide = await page.addStyleTag({ content: HIDE_TEXT })
  const shoot = async (/** @type {{ x: number, y: number, width: number, height: number } | undefined} */ clip) => (await page.screenshot({ fullPage: true, ...(clip === undefined ? {} : { clip }) })).toString('base64')
  const edges = async (/** @type {boolean} */ switchesOnly) => {
    const { jobs, ratios } = await steady(page, async () => {
      const jobs = (await page.evaluate(controls, switchesOnly)).map((one) => ({ ...one }))
      return { jobs, ratios: jobs.length === 0 ? [] : await page.evaluate(judge, { png: await shoot(undefined), origin: [0, 0], jobs }) }
    })
    jobs.forEach((job, at) => { note('edge', job.name, ratios[at] ?? null, job.box) })
    return jobs.length
  }
  try {
    // A control is measured as it rests: the scene may have left one focused, with its ring on.
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
    await settle(page)
    await edges(false)
    // A switch is drawn in two positions, and both have to stand out: it is flipped, measured, and put back.
    if (await page.evaluate(flipSwitches) > 0) { await edges(true); await page.evaluate(flipSwitches) }
    // The keyboard is what shows a focus ring, so it moves once before each element is focused by script.
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    for (const spec of FOCUS) {
      const target = page.locator(spec.focus).first()
      if (await target.count() === 0) continue
      await target.focus()
      // A control that is disabled for now (the form while a series runs) takes no focus, and the page then has nothing to show.
      if (!await target.evaluate((one) => document.activeElement === one)) continue
      await settle(page)
      const ring = await page.evaluate(ringOf, spec)
      if ('reason' in ring) { problems.push(`${here}: ${spec.name}: no focus ring: ${ring.reason}`); continue }
      const [x = 0, y = 0, width = 0, height = 0] = ring.box
      const clip = { x: Math.max(0, Math.floor(x - 30)), y: Math.max(0, Math.floor(y - 30)), width: Math.ceil(width + 60), height: Math.ceil(height + 60) }
      const png = await shoot(clip)
      // The ring is read where it was drawn: a page that moved while it was shot is read again.
      const again = await page.evaluate(ringOf, spec)
      if ('box' in again && again.box.some((value, at) => Math.abs(value - (ring.box[at] ?? 0)) > 0.5)) { problems.push(`${here}: ${spec.name}: the page moved while its focus ring was shot`); continue }
      const [found = null] = await page.evaluate(judge, { png, origin: [clip.x, clip.y], jobs: [{ box: ring.box, ring: ring.ring }] })
      note('focus ring', spec.name, found, ring.box)
    }
  } finally {
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
    await hide.evaluate((style) => { style.remove() })
  }
  for (const [key, one] of worst) problems.push(`${here}: ${key} is ${one.ratio.toFixed(2)} to 1, needs ${NEED}, at ${one.box.map(Math.round).join(',')}: ${one.where}`)
  return problems
}

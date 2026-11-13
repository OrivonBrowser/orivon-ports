// The contrast of every piece of text on a page, as the page is drawn: WCAG AA is 4.5 to 1, and 3 to 1 for large text. The colour behind a
// word can be a gradient, a picture or a translucent card, so it is read from pixels: the page is shot once with its text made invisible,
// and each word's box is measured against what is under it. The two per cent of pixels that contrast least are left out, so a single star
// or grid line behind a word does not fail it.
//
// Text is measured as a person sees it. A faded element's opacity, and every ancestor's, is blended into the text colour; where the faded
// element paints a background of its own, the page is shot a second time without the fade, so the blend is exact. A placeholder counts its own
// opacity, and SVG text is read by its `fill`. A disabled control's own text is exempt, as WCAG says; a label beside one is not.
// What is not text (the edge of a control, its focus ring) is measured by shoot-controls.mjs. Both wait for the page to stop redrawing first.

/** The style that makes every word transparent, so what is behind it shows. Shared with shoot-controls.mjs. */
export const HIDE_TEXT = '*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; transition: none !important; } svg text { fill: transparent !important; } input::placeholder { color: transparent !important; } ::selection { background: transparent !important; } .own, .finder-field .suffix { background: none !important; }'

/** What a redraw changes: the height of the page and the number of its elements. @param {import('playwright-core').Page} page */
const fingerprint = (page) => page.evaluate(() => `${document.documentElement.scrollHeight}/${document.body.getElementsByTagName('*').length}`)

/** Waits until the page stops redrawing: a fee or a lookup that answers late moves what is about to be measured. @param {import('playwright-core').Page} page */
export async function settle (page) {
  let before = ''
  for (let tries = 0; tries < 40; tries++) {
    const now = await fingerprint(page)
    if (now === before) return
    before = now
    await page.waitForTimeout(120)
  }
}

/**
 * Runs a measurement that reads the page and then its pixels, again when the page redrew in between, so a box is never read against pixels
 * of another layout. A page that will not hold still ends the tries with the last reading.
 * @template T
 * @param {import('playwright-core').Page} page
 * @param {() => Promise<T>} measureOnce
 * @returns {Promise<T>}
 */
export async function steady (page, measureOnce) {
  for (let tries = 0; ; tries++) {
    await settle(page)
    const before = await fingerprint(page)
    const result = await measureOnce()
    if (tries >= 3 || before === await fingerprint(page)) return result
  }
}

/** In the page: where each piece of text is, in what colour, how much of it shows and what size, and the colour a gradient-filled word is worst against. */
function collect () {
  const items = []
  /** The opacity a person sees an element at: its own times every ancestor's. Each level that fades is marked, so the page can be drawn again without the fade. */
  const seen = (/** @type {Element} */ one) => {
    let product = 1
    for (let at = /** @type {Element | null} */ (one); at !== null; at = at.parentElement) {
      const opacity = Number(getComputedStyle(at).opacity)
      product *= opacity
      if (opacity > 0 && opacity < 1) at.setAttribute('data-faded', '')
    }
    return product
  }
  const visible = (/** @type {Element} */ one) => {
    for (let at = /** @type {Element | null} */ (one); at !== null; at = at.parentElement) {
      const style = getComputedStyle(at)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      if (at.matches(':disabled, .visually-hidden, script, style, noscript')) return false
      // A word kept for a screen reader is cut down to a pixel, with its text still laid out at full size.
      if (style.position === 'absolute' && parseFloat(style.width) <= 1 && style.overflow === 'hidden') return false
      // What a closed disclosure holds is not drawn, though it still has boxes to measure: only its summary is.
      if (at instanceof HTMLDetailsElement && !at.open && at.querySelector(':scope > summary')?.contains(one) !== true) return false
    }
    return seen(one) > 0
  }
  const describe = (/** @type {Element} */ one, /** @type {DOMRect} */ rect, /** @type {string} */ text, /** @type {string | null} */ pseudo) => {
    const style = getComputedStyle(one, pseudo)
    const svg = one instanceof SVGElement
    // SVG text is painted by `fill`, whatever its `color` is.
    let color = svg ? style.fill : style.color
    if (color === 'none') return
    const label = `${one.tagName.toLowerCase()}${typeof one.className === 'string' && one.className !== '' ? `.${one.className.split(' ')[0]}` : ''}`
    const box = [rect.left + scrollX, rect.top + scrollY, rect.width, rect.height]
    if (color.startsWith('url(')) {
      items.push({ text: text.slice(0, 32), label, unreadable: true, box })
      return
    }
    if (style.webkitBackgroundClip === 'text') {
      // A word filled with a gradient: the stop that is darkest is the one it must pass with.
      const stops = [...style.backgroundImage.matchAll(/rgba?\(([^)]+)\)/g)].map((found) => found[1] ?? '')
      const lum = (/** @type {string} */ stop) => stop.split(',').slice(0, 3).reduce((sum, part, at) => sum + Number(part) * [0.2126, 0.7152, 0.0722][at], 0)
      color = `rgb(${stops.sort((a, b) => lum(a) - lum(b))[0] ?? '255,255,255'})`
    }
    const channels = color.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255]
    // `color(srgb 0.1 0.2 0.3 / 0.5)`, which a mixed colour computes to, has its channels from 0 to 1.
    const scale = color.startsWith('color(') ? 255 : 1
    const size = parseFloat(style.fontSize)
    const bold = Number(style.fontWeight) >= 700
    const fade = seen(one)
    // What shows of the colour: its own alpha, the fill's, the pseudo-element's own opacity (a placeholder's), and the fade of the element and its parents.
    const alpha = (channels[3] ?? 1) * (svg ? Number(style.fillOpacity) : 1) * (pseudo === null ? 1 : Number(style.opacity)) * fade
    items.push({
      text: text.slice(0, 32), label, color: [0, 1, 2].map((at) => (channels[at] ?? 255) * scale), alpha, faded: fade < 1, need: size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5, box
    })
  }
  for (const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); walker.nextNode();) {
    const text = (walker.currentNode.textContent ?? '').trim()
    const one = walker.currentNode.parentElement
    if (text === '' || one === null || !visible(one)) continue
    const range = document.createRange()
    range.selectNodeContents(walker.currentNode)
    for (const rect of range.getClientRects()) if (rect.width > 3 && rect.height > 3) describe(one, rect, text, null)
  }
  for (const input of document.querySelectorAll('input[type="text"]')) {
    if (!(input instanceof HTMLInputElement) || !visible(input)) continue
    const text = input.value === '' ? input.placeholder : input.value
    const field = input.getBoundingClientRect()
    // The box without its ring: the ring is a control's edge, not what the words stand on.
    if (text !== '') describe(input, new DOMRect(field.x + 4, field.y + 4, field.width - 8, field.height - 8), text, input.value === '' ? '::placeholder' : null)
  }
  return items
}

/**
 * In the page: the contrast of each item against the pixels of the picture, as a number it must reach, or null when it does. `full` is the
 * picture drawn again without any fade, or null when nothing fades: where an element fades with a background of its own, the text on screen
 * is the background's own colour moved toward the text by the opacity that shows, and the picture without the fade gives that colour.
 * @param {{ png: string, full: string | null, items: ReturnType<typeof collect> }} given
 */
async function measure ({ png, full, items }) {
  const read = async (/** @type {string} */ data) => {
    const picture = new Image()
    await new Promise((done, fail) => { picture.onload = done; picture.onerror = fail; picture.src = `data:image/png;base64,${data}` })
    const canvas = document.createElement('canvas')
    canvas.width = picture.width
    canvas.height = picture.height
    const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }))
    context.drawImage(picture, 0, 0)
    return { width: picture.width, height: picture.height, context }
  }
  const behindPicture = await read(png)
  const fullPicture = full === null ? null : await read(full)
  const linear = (/** @type {number} */ value) => { const unit = Math.min(255, Math.max(0, value)) / 255; return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4 }
  const luminance = (/** @type {number[]} */ rgb) => 0.2126 * linear(rgb[0] ?? 0) + 0.7152 * linear(rgb[1] ?? 0) + 0.0722 * linear(rgb[2] ?? 0)
  return items.map((item) => {
    if (item.unreadable === true) return { ratio: 0, need: 0 }
    const [x = 0, y = 0, width = 0, height = 0] = item.box.map((value) => Math.max(0, Math.floor(value)))
    const w = Math.min(width, behindPicture.width - x)
    const h = Math.min(height, behindPicture.height - y)
    if (w < 1 || h < 1) return null
    const behind = behindPicture.context.getImageData(x, y, w, h).data
    const without = item.faded && fullPicture !== null ? fullPicture.context.getImageData(x, y, w, h).data : behind
    const ratios = []
    for (let at = 0; at < behind.length; at += 4 * 3) {
      const under = [behind[at] ?? 0, behind[at + 1] ?? 0, behind[at + 2] ?? 0]
      const base = [without[at] ?? 0, without[at + 1] ?? 0, without[at + 2] ?? 0]
      const drawn = [0, 1, 2].map((channel) => (under[channel] ?? 0) + item.alpha * ((item.color[channel] ?? 0) - (base[channel] ?? 0)))
      const [light, dark] = [luminance(drawn), luminance(under)].sort((a, b) => b - a)
      ratios.push(((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05))
    }
    ratios.sort((a, b) => a - b)
    const ratio = ratios[Math.floor(ratios.length * 0.02)] ?? 21
    return ratio < item.need ? { ratio, need: item.need } : null
  })
}

/**
 * The text on the page whose contrast is under WCAG AA, as problem lines.
 * @param {import('playwright-core').Page} page
 * @param {string} here
 * @returns {Promise<string[]>}
 */
export async function contrastProblems (page, here) {
  const { items, results } = await steady(page, async () => {
    const items = await page.evaluate(collect)
    const hide = await page.addStyleTag({ content: HIDE_TEXT })
    const png = (await page.screenshot({ fullPage: true })).toString('base64')
    let full = null
    if (items.some((item) => item.faded === true)) {
      const unfade = await page.addStyleTag({ content: '[data-faded] { opacity: 1 !important; }' })
      full = (await page.screenshot({ fullPage: true })).toString('base64')
      await unfade.evaluate((style) => { style.remove() })
    }
    await hide.evaluate((style) => { style.remove() })
    await page.evaluate(() => { for (const one of document.querySelectorAll('[data-faded]')) one.removeAttribute('data-faded') })
    return { items, results: await page.evaluate(measure, { png, full, items }) }
  })
  const found = new Map()
  results.forEach((result, at) => {
    const item = items[at]
    if (result === null || item === undefined) return
    const key = `${item.label} ${item.text}`
    if (!found.has(key) || (found.get(key)?.ratio ?? 0) > result.ratio) found.set(key, { ...result, ...item })
  })
  return [...found.values()].slice(0, 8).map((one) => one.unreadable === true
    ? `${here}: text in ${one.label} "${one.text}" is filled by a paint server, which this tool cannot read`
    : `${here}: text contrast ${one.ratio.toFixed(2)} to 1, needs ${one.need}: ${one.label} "${one.text}" in rgb(${one.color.map(Math.round).join(',')}) showing ${Math.round(one.alpha * 100)}% at ${one.box.map(Math.round).join(',')}`)
}

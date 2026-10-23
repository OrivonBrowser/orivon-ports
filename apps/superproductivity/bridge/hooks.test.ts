// The two edits hooks.mjs makes to the built index.html, and the page it writes beside it.
// The fixture is the shape of upstream's output, not a copy of it: a comment that itself says
// `<script>`, one inline script, and Angular's critical-CSS link.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ALREADY_OPEN_FILE, INLINE_SCRIPT_FILE, transformHtml } from '../hooks.mjs'

const SCRIPT_BODY = "var splash = ['a', 'b'];\nnew Function('class C { static {} }')();\n"

const BUILT = [
  '<!doctype html><html><head>',
  '<!-- the inline bootstrap <script> below needs unsafe-inline -->',
  '<link rel="stylesheet" href="styles-ABC.css" media="print" onload="this.media=\'all\'"><noscript><link rel="stylesheet" href="styles-ABC.css"></noscript>',
  '</head><body><app-root></app-root>',
  `<script>${SCRIPT_BODY}</script>`,
  '<script src="main-XYZ.js" type="module"></script>',
  '</body></html>'
].join('\n')

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sp-hooks-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const run = (html: string) => transformHtml(html, { dirs: { static: dir } })

describe('the inline script', () => {
  it('moves byte for byte to a file, and the page loads it in the same place', async () => {
    const html = await run(BUILT)
    expect(await readFile(join(dir, INLINE_SCRIPT_FILE), 'utf8')).toBe(SCRIPT_BODY)
    expect(html).toContain(`<script src="${INLINE_SCRIPT_FILE}"></script>\n<script src="main-XYZ.js" type="module">`)
    expect(html).not.toContain('var splash')
  })

  it('leaves a comment that mentions <script> exactly as it was', async () => {
    expect(await run(BUILT)).toContain('<!-- the inline bootstrap <script> below needs unsafe-inline -->')
  })

  it('refuses a page with more than one inline script, which means upstream changed shape', async () => {
    await expect(run(`${BUILT}<script>var more = 1</script>`)).rejects.toThrow(/found 2/)
  })
})

describe('the stylesheet', () => {
  it('applies at once: the print media and the onload handler are gone', async () => {
    const html = await run(BUILT)
    expect(html).toContain('<link rel="stylesheet" href="styles-ABC.css"><noscript>')
    expect(html).not.toMatch(/onload=/)
    expect(html).not.toContain('media="print"')
  })
})

describe('a document already rewritten', () => {
  it('comes back unchanged, so prepare may run twice', async () => {
    const once = await run(BUILT)
    expect(await run(once)).toBe(once)
  })
})

describe('the page a second tab is sent to', () => {
  it('is written beside the app, and runs no script', async () => {
    await run(BUILT)
    const page = await readFile(join(dir, ALREADY_OPEN_FILE), 'utf8')
    expect(page).toContain('Super Productivity is already open')
    expect(page).not.toMatch(/<script|onload=|onclick=/)
  })
})

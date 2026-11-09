// The two edits hooks.mjs makes to the built index.html, and the two files it writes beside it.
// The fixture is the shape of upstream's output, not a copy of it: a comment that itself says
// `<script>`, the three inline scripts, and Angular's critical-CSS link.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha1Hex } from '../../../src/build/ngsw-kit.mjs'
import { ALREADY_OPEN_FILE, finishTree, inlineScriptFile, PLUGIN_FRAME_FILE, transformHtml } from '../hooks.mjs'

const LAUNCH_BODY = "(function () { document.documentElement.style.setProperty('--sp-bg', '#131314') })();\n"
const SCRIPT_BODY = "var splash = ['a', 'b'];\nnew Function('class C { static {} }')();\n"
const RESTORE_BODY = "document.querySelectorAll('link[data-beasties-media]').forEach(function(l){l.media=l.getAttribute('data-beasties-media')})"

const BUILT = [
  '<!doctype html><html><head>',
  '<!-- the inline bootstrap <script> below needs unsafe-inline -->',
  `<script>${LAUNCH_BODY}</script>`,
  '<link rel="stylesheet" href="styles-ABC.css" media="print" data-beasties-media="all"><noscript><link rel="stylesheet" href="styles-ABC.css"></noscript>',
  '</head><body><app-root></app-root>',
  `<script>${SCRIPT_BODY}</script>`,
  '<script src="main-XYZ.js" type="module"></script>',
  `<script>${RESTORE_BODY}</script>`,
  '</body></html>'
].join('\n')

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sp-hooks-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const run = (html: string) => transformHtml(html, { dirs: { static: dir } })

describe('the inline scripts', () => {
  it('move byte for byte to files, and the page loads each in the place it stood', async () => {
    const html = await run(BUILT)
    expect(await readFile(join(dir, inlineScriptFile(0)), 'utf8')).toBe(LAUNCH_BODY)
    expect(await readFile(join(dir, inlineScriptFile(1)), 'utf8')).toBe(SCRIPT_BODY)
    expect(await readFile(join(dir, inlineScriptFile(2)), 'utf8')).toBe(RESTORE_BODY)
    expect(html).toContain(`<script src="${inlineScriptFile(0)}"></script>\n<link rel="stylesheet"`)
    expect(html).toContain(`<script src="${inlineScriptFile(1)}"></script>\n<script src="main-XYZ.js" type="module"></script>\n<script src="${inlineScriptFile(2)}"></script>`)
    expect(html).not.toContain('var splash')
    expect(html).not.toContain('--sp-bg')
  })

  it('leave a comment that mentions <script> exactly as it was', async () => {
    expect(await run(BUILT)).toContain('<!-- the inline bootstrap <script> below needs unsafe-inline -->')
  })

  it('are refused when there are not three, which means upstream changed shape', async () => {
    await expect(run(`${BUILT}<script>var more = 1</script>`)).rejects.toThrow(/found 4/)
    await expect(run(BUILT.replace(`<script>${LAUNCH_BODY}</script>`, ''))).rejects.toThrow(/found 2/)
  })
})

describe('the stylesheet', () => {
  it('applies at once: the print media and the attribute that waits for the restoring script are gone', async () => {
    const html = await run(BUILT)
    expect(html).toContain('<link rel="stylesheet" href="styles-ABC.css"><noscript>')
    expect(html).not.toContain('data-beasties-media')
    expect(html).not.toContain('media="print"')
  })

  it('is refused when it still waits on something after the edit, which means upstream changed shape', async () => {
    const waits = BUILT.replace('media="print" data-beasties-media="all"', 'media="print" onload="this.media=\'all\'"')
    await expect(run(waits)).rejects.toThrow(/critical-CSS markup changed shape/)
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

describe('the script a plugin\'s page runs its inline scripts with', () => {
  it('is written to the file the bridge names, byte for byte what the repository holds', async () => {
    await run(BUILT)
    const served = await readFile(join(dir, PLUGIN_FRAME_FILE), 'utf8')
    expect(served).toBe(await readFile(new URL('./plugin-frame.js', import.meta.url), 'utf8'))
    expect(PLUGIN_FRAME_FILE).toBe('orivon/plugin-frame.js')
  })
})

describe('the service worker manifest', () => {
  const hashes = (text: string): Record<string, string> => (JSON.parse(text) as { hashTable: Record<string, string> }).hashTable

  it('names the page the hook left, not the page the build wrote: the worker refuses an app version whose index.html hashes otherwise', async () => {
    const built = { '/index.html': sha1Hex(Buffer.from(BUILT)), '/main-XYZ.js': sha1Hex(Buffer.from('main')) }
    await writeFile(join(dir, 'main-XYZ.js'), 'main')
    await writeFile(join(dir, 'ngsw.json'), JSON.stringify({ assetGroups: [{ name: 'app', urls: Object.keys(built) }], hashTable: built }, null, 2))
    await writeFile(join(dir, 'index.html'), await run(BUILT))
    await finishTree({ dirs: { static: dir } })
    const table = hashes(await readFile(join(dir, 'ngsw.json'), 'utf8'))
    expect(table['/index.html']).toBe(sha1Hex(await readFile(join(dir, 'index.html'))))
    expect(table['/index.html']).not.toBe(built['/index.html'])
    expect(table['/main-XYZ.js']).toBe(built['/main-XYZ.js'])
  })

  it('also caches what the port serves beside the app: the inline scripts the page now loads from files', async () => {
    await writeFile(join(dir, 'ngsw.json'), JSON.stringify({ assetGroups: [{ name: 'app', urls: [] }], hashTable: {} }, null, 2))
    await writeFile(join(dir, 'index.html'), await run(BUILT))
    await finishTree({ dirs: { static: dir } })
    const manifest = JSON.parse(await readFile(join(dir, 'ngsw.json'), 'utf8')) as { assetGroups: Array<{ name: string, urls: string[] }>, hashTable: Record<string, string> }
    const cached = manifest.assetGroups.find((group) => group.name === 'orivon')?.urls ?? []
    for (let index = 0; index < 3; index++) expect(cached).toContain(`/${inlineScriptFile(index)}`)
    expect(cached).toContain(`/${PLUGIN_FRAME_FILE}`)
    for (const url of cached) expect(manifest.hashTable[url]).toBe(sha1Hex(await readFile(join(dir, url.slice(1)))))
  })
})

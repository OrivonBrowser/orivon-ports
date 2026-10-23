import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildMultipart } from '../page/src/publish/multipart.js'
import { KNOWN_CORES, LIMITS, Refusal, boundaryOf, canonicalUpload, checkUpload, parseMultipart } from '../relay/rules.mjs'
import { KEEP_DAYS, addPin, due, markDropped, markExpired, pinsFile, readPins, usage } from '../relay/store.mjs'

const encoder = new TextEncoder()
const CORE_NAME = 'tiddlywikicore-5.4.1.js'
const PAGE = `<!doctype html><html><body><script class="tiddlywiki-tiddler-store" type="application/json">[{"title":"$:/plugins/orivon/decentrawiki","text":"{}"}]</script><script src="${CORE_NAME}" onerror="x"></script></body></html>`

/** A core whose bytes the test can name: the relay is given its hash in place of the real one. */
const coreBytes = encoder.encode('/* a TiddlyWiki core, for the test */')
const realCore = KNOWN_CORES[CORE_NAME]

beforeEach(() => { (KNOWN_CORES as Record<string, string>)[CORE_NAME] = createHash('sha256').update(coreBytes).digest('hex') })
afterEach(() => { (KNOWN_CORES as Record<string, string>)[CORE_NAME] = realCore })

/** An upload exactly as the editor's kuboAdd builds it: the folder first, then its files. */
function upload (files: Record<string, Uint8Array | string>, root = 'wiki') {
  const parts: { name: string, filename: string, contentType: string, bytes: Uint8Array }[] = [{ name: 'file', filename: encodeURIComponent(root), contentType: 'application/x-directory', bytes: new Uint8Array(0) }]
  for (const [path, bytes] of Object.entries(files)) {
    parts.push({ name: 'file', filename: encodeURIComponent(`${root}/${path}`), contentType: 'application/octet-stream', bytes: typeof bytes === 'string' ? encoder.encode(bytes) : bytes })
  }
  const { body, contentType } = buildMultipart(parts)
  const boundary = boundaryOf(contentType)
  if (boundary === null) throw new Error('no boundary')
  return parseMultipart(body, boundary)
}

async function refusal (promise: Promise<unknown>): Promise<Refusal> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Refusal) return error
    throw error
  }
  throw new Error('accepted what should be refused')
}

describe('what free pinning accepts', () => {
  it('takes one published wiki as the editor sends it', async () => {
    const checked = await checkUpload(upload({ 'index.html': PAGE, [CORE_NAME]: coreBytes, 'favicon.ico': new Uint8Array([0, 0, 1, 0]) }))
    expect(checked.rootName).toBe('wiki')
    expect(checked.files.map((f) => f.path).sort()).toEqual(['favicon.ico', 'index.html', CORE_NAME])
    expect(new TextDecoder().decode(checked.files.find((f) => f.path === 'index.html')?.bytes)).toBe(PAGE)
  })

  it('refuses a page the editor did not publish', async () => {
    expect((await refusal(checkUpload(upload({ 'index.html': '<html>phish</html>', [CORE_NAME]: coreBytes })))).message).toMatch(/not a page the DecentraWiki editor published/)
    const noPlugin = PAGE.replace('$:/plugins/orivon/decentrawiki', '$:/plugins/someone/else')
    expect((await refusal(checkUpload(upload({ 'index.html': noPlugin, [CORE_NAME]: coreBytes })))).status).toBe(400)
  })

  it('refuses a core that is not the one it names, and an unknown core', async () => {
    expect((await refusal(checkUpload(upload({ 'index.html': PAGE, [CORE_NAME]: 'evil()' })))).message).toMatch(/not the TiddlyWiki core it names/)
    expect((await refusal(checkUpload(upload({ 'index.html': PAGE.replace(CORE_NAME, 'tiddlywikicore-9.9.9.js'), 'tiddlywikicore-9.9.9.js': coreBytes })))).message).toMatch(/not part of a DecentraWiki wiki/)
  })

  it('refuses any other file, a second folder, and a file outside the folder', async () => {
    expect((await refusal(checkUpload(upload({ 'index.html': PAGE, [CORE_NAME]: coreBytes, 'movie.mp4': 'x' })))).message).toMatch(/movie\.mp4 is not part/)
    expect((await refusal(checkUpload(upload({ 'index.html': PAGE, [CORE_NAME]: coreBytes, 'sub/a.html': 'x' })))).status).toBe(400)
    const parts = upload({ 'index.html': PAGE, [CORE_NAME]: coreBytes })
    parts.push({ headers: { 'content-disposition': 'form-data; name="file"; filename="other"', 'content-type': 'application/x-directory' }, bytes: new Uint8Array(0) })
    expect((await refusal(checkUpload(parts))).message).toMatch(/one folder/)
  })

  it('refuses a wiki with no page, and one too large', async () => {
    expect((await refusal(checkUpload(upload({ [CORE_NAME]: coreBytes })))).message).toMatch(/has an index\.html/)
    const big = PAGE + ' '.repeat(LIMITS.pageBytes)
    expect((await refusal(checkUpload(upload({ 'index.html': big, [CORE_NAME]: coreBytes })))).status).toBe(413)
  })

  it('refuses a page that is not the editor\'s shape, and an icon that is not an image', async () => {
    const core = { [CORE_NAME]: coreBytes }
    const words = async (html: string | Uint8Array) => (await refusal(checkUpload(upload({ 'index.html': html, ...core })))).message
    expect(await words(PAGE.replace('<!doctype html>', ''))).toMatch(/not a page the DecentraWiki editor published/)
    expect(await words(PAGE.replace('</body>', '<script>steal()</script></body>'))).toMatch(/scripts of its own/)
    expect(await words(PAGE.replace('</body>', '\u0000</body>'))).toMatch(/not a page/)
    expect(await words(new Uint8Array([...encoder.encode(PAGE), 0xff, 0xfe]))).toMatch(/not a page/)
    expect(await words(PAGE + PAGE)).toMatch(/not a page/)
    expect((await refusal(checkUpload(upload({ 'index.html': PAGE, ...core, 'favicon.ico': 'MZ not an icon' })))).message).toMatch(/icon is not an image/)
  })

  it('refuses a header any parser could read two ways', async () => {
    const raw = (head: string) => encoder.encode(`--b\r\n${head}\r\n\r\nx\r\n--b--\r\n`)
    expect(() => parseMultipart(raw('Content-Disposition: form-data; name="file"; filename="wiki/a"\r\nContent-Disposition: form-data; name="file"; filename="wiki/index.html"'), 'b')).toThrow(Refusal)
    expect(() => parseMultipart(raw('Content-Disposition: form-data; name="file";\r\n filename="wiki/index.html"'), 'b')).toThrow(Refusal)
    expect(() => parseMultipart(raw('no colon here'), 'b')).toThrow(Refusal)
    const parts = upload({ 'index.html': PAGE, [CORE_NAME]: coreBytes })
    const [first] = parts.splice(1, 1)
    parts.push({ headers: { ...first!.headers, 'content-type': 'application/x-directory; x=1' }, bytes: first!.bytes })
    expect((await refusal(checkUpload(parts))).message).toMatch(/one folder/)
  })

  it('forwards the checked files in the editor\'s own form, whatever form they came in', async () => {
    const checked = await checkUpload(upload({ 'index.html': PAGE, [CORE_NAME]: coreBytes }))
    const { body, contentType } = canonicalUpload(checked.rootName, checked.files)
    const again = await checkUpload(parseMultipart(body, boundaryOf(contentType) ?? ''))
    expect(again.rootName).toBe('wiki')
    expect(again.files).toEqual(checked.files)
  })

  it('reads only a well-formed form', () => {
    expect(boundaryOf('application/json')).toBeNull()
    expect(boundaryOf('multipart/form-data; boundary=----orivonabc')).toBe('----orivonabc')
    expect(() => parseMultipart(encoder.encode('garbage'), 'b')).toThrow(Refusal)
    expect(() => parseMultipart(encoder.encode('--b\r\nContent-Disposition: form-data; name="file"\r\n\r\nno end'), 'b')).toThrow(/cut short/)
  })
})

describe('the record of free pins', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dw-relay-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('keeps what it adds across reads, and survives a line cut short', async () => {
    const file = pinsFile(dir)
    await addPin(file, { cid: 'bafyone', at: 1, bytes: 10, preexisting: false, expired: false })
    await addPin(file, { cid: 'bafytwo', at: 2, bytes: 20, preexisting: true, expired: false })
    const { appendFile } = await import('node:fs/promises')
    await appendFile(file, '{"cid":"bafythr')
    expect([...(await readPins(file)).keys()]).toEqual(['bafyone', 'bafytwo'])
  })

  it('only appends: an end or a drop is a line of its own, and the first pin line of a CID stands', async () => {
    const file = pinsFile(dir)
    await addPin(file, { cid: 'bafyone', at: 1, bytes: 10, preexisting: false, expired: false })
    await addPin(file, { cid: 'bafytwo', at: 2, bytes: 20, preexisting: false, expired: false })
    await addPin(file, { cid: 'bafyone', at: 9, bytes: 99, preexisting: true, expired: false })
    await markExpired(file, 'bafyone')
    await markDropped(file, 'bafytwo')
    let pins = await readPins(file)
    expect(pins.get('bafyone')).toEqual({ cid: 'bafyone', at: 1, bytes: 10, preexisting: false, expired: true })
    expect(pins.has('bafytwo')).toBe(false)
    await addPin(file, { cid: 'bafytwo', at: 5, bytes: 20, preexisting: false, expired: false })
    pins = await readPins(file)
    expect(pins.get('bafytwo')?.at).toBe(5)
    expect(usage(pins, 3)).toEqual({ live: 20, recent: 20 })
  })

  it('ends a pin after its month, never one the account held before, never twice', () => {
    const day = 24 * 60 * 60 * 1000
    const now = 100 * day
    const pins = new Map([
      ['old', { cid: 'old', at: now - KEEP_DAYS * day, bytes: 1, preexisting: false, expired: false }],
      ['young', { cid: 'young', at: now - (KEEP_DAYS - 1) * day, bytes: 1, preexisting: false, expired: false }],
      ['ours', { cid: 'ours', at: 0, bytes: 1, preexisting: true, expired: false }],
      ['done', { cid: 'done', at: 0, bytes: 1, preexisting: false, expired: true }]
    ])
    expect(due(pins, now).map((p) => p.cid)).toEqual(['old'])
  })
})

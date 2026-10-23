import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildMultipart } from '../page/src/publish/multipart.js'
import { KNOWN_CORES, LIMITS, Refusal, boundaryOf, checkUpload, parseMultipart } from '../relay/rules.mjs'
import { KEEP_DAYS, addPin, due, pinsFile, readPins, writePins } from '../relay/store.mjs'

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
    const pins = await readPins(file)
    expect([...pins.keys()]).toEqual(['bafyone', 'bafytwo'])
    pins.set('bafyone', { ...(pins.get('bafyone') as NonNullable<ReturnType<typeof pins.get>>), expired: true })
    await writePins(file, pins)
    expect((await readPins(file)).get('bafyone')?.expired).toBe(true)
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

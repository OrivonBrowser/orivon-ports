import { describe, expect, it } from 'vitest'
import { parseCid } from '../page/src/ipfs/cid.js'
import { SHARE_ORIGIN, parseShareLink, shareLink } from '../page/src/lib/links.js'
import { MANIFEST_NAME, manifestText, parseManifest } from '../page/src/lib/manifest.js'
import { generatePassword, passwordStrength } from '../page/src/lib/passwords.js'
import { checkSelection, entriesFromDrop, entriesFromInput } from '../page/src/lib/selection.js'

type FileSystemEntry = Record<string, unknown>
type DataTransfer = { items: any[], files: any[] }

const CID = 'bafybeiek6rgo53nnksskarhmyk2ussqywifoxhs45j7y3l4mlis5nlqziu'
const RAW_CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'

const file = (text: string, name = 'f') => new File([text], name)
const sized = (size: number) => ({ size }) as unknown as Blob

describe('generatePassword', () => {
  it('makes five groups of five Crockford base32 characters', () => {
    for (let i = 0; i < 50; i++) expect(generatePassword()).toMatch(/^[0-9a-hjkmnp-tv-z]{5}(-[0-9a-hjkmnp-tv-z]{5}){4}$/)
  })

  it('does not repeat, and uses the whole alphabet', () => {
    const seen = new Set<string>()
    const letters = new Set<string>()
    for (let i = 0; i < 400; i++) {
      const password = generatePassword()
      seen.add(password)
      for (const char of password.replaceAll('-', '')) letters.add(char)
    }
    expect(seen.size).toBe(400)
    expect(letters.size).toBe(32)
  })

  it('is accepted as very strong', () => {
    expect(passwordStrength(generatePassword())).toMatchObject({ label: 'very strong', acceptable: true })
  })
})

describe('passwordStrength', () => {
  it('blocks what is short, common or padded, and says why', () => {
    expect(passwordStrength('short')).toMatchObject({ label: 'weak', acceptable: false, hint: expect.stringContaining('10') })
    expect(passwordStrength('password123')).toMatchObject({ label: 'weak', acceptable: false })
    expect(passwordStrength('Password1234!')).toMatchObject({ label: 'weak', acceptable: false })
    expect(passwordStrength('1234567890')).toMatchObject({ label: 'weak', acceptable: false })
    expect(passwordStrength('aaaaaaaaaaaa')).toMatchObject({ label: 'weak', acceptable: false })
    expect(passwordStrength('abcdefghijkl')).toMatchObject({ label: 'weak', acceptable: false })
    expect(passwordStrength(' padded-password ')).toMatchObject({ acceptable: false, hint: expect.stringContaining('space') })
  })

  it('warns about a fair one and passes a strong one', () => {
    expect(passwordStrength('correct horse')).toMatchObject({ label: 'fair', acceptable: true })
    expect(passwordStrength('Tr0ub4dor&3xyz')).toMatchObject({ acceptable: true })
    expect(['strong', 'very strong']).toContain(passwordStrength('k7Q!vx2Lm9#pRt4w').label)
  })

  it('counts characters, not UTF-16 units', () => {
    expect(passwordStrength('😀'.repeat(5))).toMatchObject({ acceptable: false, hint: expect.stringContaining('10') })
    expect(passwordStrength('😀🙂🙃😉😊😇🥰😍🤩😘').hint).not.toContain('at least')
  })
})

describe('share links', () => {
  it('writes the link of a share and one with the password in it', () => {
    expect(shareLink(CID)).toBe(`${SHARE_ORIGIN}/#/${CID}`)
    expect(SHARE_ORIGIN).toBe('https://share.orivonstack.eth.limo')
    expect(shareLink(CID, 'my pass: ünï')).toBe(`${SHARE_ORIGIN}/#/${CID}?key=bXkgcGFzczogw7xuw68`)
    expect(shareLink(CID, '')).toBe(`${SHARE_ORIGIN}/#/${CID}`)
  })

  it('reads back what it wrote, whatever the password holds', () => {
    for (const password of ['abc', 'a', 'ab', '?&=#/ +%', 'ünï日本語😀', 'x'.repeat(200)]) {
      expect(parseShareLink(shareLink(CID, password))).toEqual({ cid: CID, password })
    }
    expect(parseShareLink(shareLink(CID))).toEqual({ cid: CID, password: null })
  })

  it('reads every form a person pastes', () => {
    const want = { cid: CID, password: null }
    for (const text of [`${SHARE_ORIGIN}/#/${CID}`, `http://127.0.0.1:8880/#/${CID}`, `ipfs://${CID}/`, `ipfs://${CID}`, CID, `  ${CID}\n`, `#/${CID}`, `/#/${CID}`, `https://${CID}.ipfs.dweb.link/`, `https://gateway.example/ipfs/${CID}/a.txt`]) {
      expect(parseShareLink(text), text).toEqual(want)
    }
    expect(parseShareLink(`ipfs://${parseCid(CID).string}/x`)).toEqual(want)
    expect(parseShareLink(`#/${CID}?key=YWJj`)).toEqual({ cid: CID, password: 'abc' })
  })

  it('turns a CIDv0 into the address Share uses', () => {
    expect(parseShareLink('QmY9cxiHqTFoWamkQVkpmmqzBrY3hCBEL2XNu3NtX74Fuu')?.cid).toBe('bafybeierygapfancqypsshj2jh4oesqczz75r7mplry3tvwucftekwqczq')
  })

  it('says nothing for what is not a share, and drops a key it cannot read', () => {
    for (const text of ['', 'hello', 'https://example.com/', `#/${CID.slice(0, -2)}`, RAW_CID, `ipfs://${RAW_CID}`, 'ipfs://']) expect(parseShareLink(text), text).toBeNull()
    expect(parseShareLink(`#/${CID}?key=@@@`)).toEqual({ cid: CID, password: null })
    expect(parseShareLink(`#/${CID}?key=${'A'}`)).toEqual({ cid: CID, password: null })
    expect(parseShareLink(`#/${CID}?key=_w`)).toEqual({ cid: CID, password: null })
  })
})

describe('the description inside a protected share', () => {
  it('is written and read back, with the limits on title and message', () => {
    const text = manifestText({ kind: 'folder', title: 'T'.repeat(500), message: 'm'.repeat(5000), files: 3, bytes: 99, now: new Date('2026-10-26T12:00:00Z') })
    const manifest = parseManifest(text)
    expect(manifest).toMatchObject({ format: 'orivon-share', version: 1, kind: 'folder', created: '2026-10-26T12:00:00.000Z', files: 3, bytes: 99 })
    expect([...manifest.title]).toHaveLength(120)
    expect([...manifest.message]).toHaveLength(2000)
    expect(MANIFEST_NAME).toBe('.orivon-share.json')
    expect(Object.keys(JSON.parse(text))).toEqual(['format', 'version', 'kind', 'title', 'message', 'created', 'files', 'bytes'])
  })

  it('refuses a description that is not one', () => {
    const good = JSON.parse(manifestText({ kind: 'files', files: 1, bytes: 1 }))
    const bad = (change: object) => parseManifest(JSON.stringify({ ...good, ...change }))
    expect(() => parseManifest('nope')).toThrow('no readable description')
    expect(() => parseManifest('[]')).toThrow('not valid')
    expect(() => bad({ format: 'other' })).toThrow('not valid')
    expect(() => bad({ version: 2 })).toThrow('newer version')
    expect(() => bad({ kind: 'photos' })).toThrow('kind')
    expect(() => bad({ title: 'x'.repeat(121) })).toThrow('title')
    expect(() => bad({ message: 5 })).toThrow('message')
    expect(() => bad({ created: 'yesterday' })).toThrow('date')
    expect(() => bad({ files: -1 })).toThrow('size')
    expect(() => bad({ bytes: 1.5 })).toThrow('size')
  })
})

describe('entriesFromInput', () => {
  it('takes the relative path of a picked folder, and the name of a picked file', () => {
    const inFolder = Object.assign(file('x', 'a.txt'), { webkitRelativePath: 'site/docs/a.txt' })
    const plain = file('y', 'b.txt')
    expect(entriesFromInput([inFolder, plain]).map((e) => e.path)).toEqual(['site/docs/a.txt', 'b.txt'])
  })
})

/** Just enough of the drag and drop API: a tree of entries with the calls the page makes. */
function dropped (tree: Record<string, string | object>) {
  const make = (name: string, value: string | object): FileSystemEntry => {
    if (typeof value === 'string') {
      return { name, isFile: true, isDirectory: false, file: (ok: (f: File) => void) => ok(file(value, name)) } as unknown as FileSystemEntry
    }
    const children = Object.entries(value).map(([childName, child]) => make(childName, child as string | object))
    return {
      name,
      isFile: false,
      isDirectory: true,
      createReader: () => {
        let given = false
        return { readEntries: (ok: (e: FileSystemEntry[]) => void) => { const batch = given ? [] : children; given = true; ok(batch) } }
      }
    } as unknown as FileSystemEntry
  }
  const items = Object.entries(tree).map(([name, value]) => ({ kind: 'file', webkitGetAsEntry: () => make(name, value), getAsFile: () => null }))
  return { items, files: [] } as unknown as DataTransfer
}

describe('entriesFromDrop', () => {
  it('walks a dropped folder and keeps its name in the paths', async () => {
    const entries = await entriesFromDrop(dropped({ site: { 'index.html': '<h1>', css: { 'a.css': 'b{}' } }, 'notes.txt': 'n' }))
    expect(entries.map((e) => e.path).sort()).toEqual(['notes.txt', 'site/css/a.css', 'site/index.html'])
    expect(await entries.find((e) => e.path === 'site/index.html')!.file.text()).toBe('<h1>')
  })

  it('reads the items before awaiting anything, since the browser empties them', async () => {
    const dataTransfer = dropped({ a: 'x', b: 'y' })
    const items = dataTransfer.items as unknown as { webkitGetAsEntry: () => unknown }[]
    let emptied = false
    const original = items.map((item) => item.webkitGetAsEntry)
    items.forEach((item, index) => { item.webkitGetAsEntry = () => { if (emptied) throw new Error('read after the drop ended'); return original[index]!() } })
    const pending = entriesFromDrop(dataTransfer)
    emptied = true
    expect((await pending).map((e) => e.path).sort()).toEqual(['a', 'b'])
  })

  it('falls back to the plain file list', async () => {
    const dataTransfer = { items: [], files: [file('x', 'a.txt')] } as unknown as DataTransfer
    expect((await entriesFromDrop(dataTransfer)).map((e) => e.path)).toEqual(['a.txt'])
  })
})

describe('checkSelection', () => {
  const entry = (path: string, text = 'x') => ({ path, file: file(text, path) })

  it('accepts files as they are, folders included', () => {
    const result = checkSelection([entry('a.txt'), entry('notes/b.txt')], 'files')
    expect(result).toMatchObject({ ok: true, bytes: 2, files: 2 })
  })

  it('names two items with the same name', () => {
    expect(checkSelection([entry('a.txt'), entry('a.txt')], 'files')).toMatchObject({ ok: false, reason: expect.stringContaining('"a.txt"') })
    expect(checkSelection([entry('a'), entry('a/b')], 'files')).toMatchObject({ ok: false, reason: expect.stringContaining('both a file and a folder') })
  })

  it('asks for one folder when sharing a folder', () => {
    expect(checkSelection([entry('site/a'), entry('site/b/c')], 'folder')).toMatchObject({ ok: true })
    expect(checkSelection([entry('a'), entry('b')], 'folder')).toMatchObject({ ok: false, reason: expect.stringContaining('one folder') })
    expect(checkSelection([entry('x/a'), entry('y/b')], 'folder')).toMatchObject({ ok: false })
  })

  it('takes the picked folder\'s own name off a website, and wants index.html at its top', () => {
    const result = checkSelection([entry('mysite/index.html'), entry('mysite/css/a.css')], 'website')
    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.entries.map((e) => e.path)).toEqual(['index.html', 'css/a.css'])
    const flat = checkSelection([entry('index.html'), entry('a.css')], 'website')
    if (flat.ok) expect(flat.entries.map((e) => e.path)).toEqual(['index.html', 'a.css'])
    expect(checkSelection([entry('mysite/pages/index.html')], 'website')).toMatchObject({ ok: false, reason: expect.stringContaining('index.html') })
    expect(checkSelection([entry('mysite/Index.html')], 'website')).toMatchObject({ ok: false })
  })

  it('refuses nothing, names that cannot be kept, and too much', () => {
    expect(checkSelection([], 'files')).toMatchObject({ ok: false })
    expect(checkSelection([], 'website')).toMatchObject({ ok: false, reason: expect.stringContaining('folder') })
    for (const path of ['../a', 'a/../b', 'a\\b', 'a\nb', '.', 'a//b']) expect(checkSelection([entry(path)], 'files'), path).toMatchObject({ ok: false })
    expect(checkSelection([{ path: 'a'.repeat(300), file: file('x') }], 'files')).toMatchObject({ ok: false, reason: expect.stringContaining('too long') })
    expect(checkSelection([{ path: 'big', file: sized(2 * 1024 ** 3) }], 'files')).toMatchObject({ ok: false, reason: expect.stringContaining('at most') })
    const many = Array.from({ length: 10_001 }, (_, i) => entry(`d${i % 20}/f${i}`))
    expect(checkSelection(many, 'files')).toMatchObject({ ok: false, reason: expect.stringContaining('10,000') })
  })

  it('refuses a folder Kubo would shard, naming it', () => {
    const wide = Array.from({ length: 1001 }, (_, i) => entry(`photos/${i}`))
    expect(checkSelection(wide, 'folder')).toMatchObject({ ok: false, reason: expect.stringContaining('"photos"') })
    const long = Array.from({ length: 900 }, (_, i) => entry(`${String(i).padStart(5, '0').padEnd(255, 'x')}`))
    expect(checkSelection(long, 'files')).toMatchObject({ ok: true })
    expect(checkSelection([...long, entry('x'.repeat(254) + '1')], 'files')).toMatchObject({ ok: false, reason: expect.stringContaining('KiB') })
  })
})

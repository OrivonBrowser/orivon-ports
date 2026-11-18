// What a person is shown and sent to get a board listed: the directories read from the lists' defaults file, the GitHub address that
// opens a prefilled issue, the text of the issue (the entry, what the board misses, the signed message and how to verify it), and
// that the line that verifies it really does, in a shell, from the board's address alone.
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { describe, expect, it } from 'vitest'
import { blobUrl, directoriesOf, fileOf, issueUrl, LISTS_RAW, requestOf, verifyCommand, VERIFY_SCRIPT } from '../../page/dashboard/listing-links.js'
import { requirementsOf, unmetOf } from '../../page/dashboard/listing-requirements.js'
import { entryOf, messageOf, signRequest } from '../worker/listing-request.js'

const DEFAULTS_5CHAN = {
  title: '5chan Directory Defaults',
  directories: {
    a: { directoryCode: 'a', title: '/a/ - Anime & Manga', features: { pseudonymityMode: 'per-reply', safeForWork: true }, rules: ['Stay on topic.'] },
    '3': { directoryCode: '3', title: '/3/ - 3DCG', features: {}, rules: [] },
    b: { directoryCode: 'b', title: '/b/ - Random' }
  }
}
const DEFAULTS_SEEDIT = { directories: { cats: { directoryCode: 'cats', title: 'Cats', tags: ['cats'] }, aww: { directoryCode: 'aww', title: 'Aww' } } }

describe('the directories', () => {
  it('are read from the lists\' defaults file, one to a code, in the order of their codes, with their requirements', () => {
    const list = directoriesOf('5chan', DEFAULTS_5CHAN)
    expect(list.map((one) => one.code)).toEqual(['3', 'a', 'b'])
    expect(list[1]).toMatchObject({ code: 'a', title: '/a/ - Anime & Manga', file: '5chan-directories/5chan-a-directory.json' })
    expect(list[1]!.requirements.map((one) => one.type)).toEqual(['pseudonymityMode', 'safeForWork', 'noGallery', 'pendingApproval', 'rules'])
    expect(list[2]!.requirements.map((one) => one.type)).toEqual(['noGallery', 'pendingApproval'])
  })

  it('are the seedit routes for seedit, which sets no requirement a record can be checked against', () => {
    const list = directoriesOf('seedit', DEFAULTS_SEEDIT)
    expect(list.map((one) => [one.code, one.file])).toEqual([['aww', 'seedit-directories/seedit-aww-directory.json'], ['cats', 'seedit-directories/seedit-cats-directory.json']])
    expect(list[0]!.requirements).toEqual([])
  })

  it('skip a code that is not a code, and answer nothing for a file that is not the defaults', () => {
    expect(directoriesOf('5chan', { directories: { 'a/../b': { title: 'x' }, ok: { title: 'ok' }, '': {}, bad: 5 } }).map((one) => one.code)).toEqual(['ok'])
    expect(directoriesOf('5chan', null)).toEqual([])
    expect(directoriesOf('5chan', { directories: [] })).toEqual([])
    expect(directoriesOf('5chan', 'x')).toEqual([])
  })

  it('name where the files are: raw for the page, blob for a person', () => {
    expect(LISTS_RAW).toBe('https://raw.githubusercontent.com/bitsocialnet/lists/master/')
    expect(fileOf('5chan', '3')).toBe('5chan-directories/5chan-3-directory.json')
    expect(blobUrl('5chan-directories/5chan-a-directory.json')).toBe('https://github.com/bitsocialnet/lists/blob/master/5chan-directories/5chan-a-directory.json')
  })
})

describe('the issue address', () => {
  it('opens a new issue of the lists with the title and the body, which come back as they went in', () => {
    const title = 'Add a board to /a/: music.bso'
    const body = '## Board\nAddress: a & b = "c" ## # `x`\né \u{1F600}\n'
    const url = new URL(issueUrl({ title, body }))
    expect(url.origin + url.pathname).toBe('https://github.com/bitsocialnet/lists/issues/new')
    expect([...url.searchParams.keys()]).toEqual(['title', 'body'])
    expect(url.searchParams.get('title')).toBe(title)
    expect(url.searchParams.get('body')).toBe(body)
  })
})

async function key () {
  const made = await generateKeyPair('Ed25519')
  return { privateKey: Buffer.from(made.raw.subarray(0, 32)).toString('base64'), address: peerIdFromPrivateKey(made).toString() }
}

async function fixture (over: { file?: string, owner?: string, record?: Record<string, unknown> } = {}) {
  const board = await key()
  const file = over.file ?? '5chan-directories/5chan-a-directory.json'
  const entry = entryOf({ file, address: 'music.bso', publicKey: board.address, addedAt: 1_800_000_123, ...(over.owner === undefined ? {} : { owner: over.owner }) })
  const message = messageOf({ file, entry })
  const signature = await signRequest({ message, privateKey: board.privateKey, publicKey: board.address })
  const directory = directoriesOf('5chan', DEFAULTS_5CHAN)[1]!
  const record = over.record ?? { features: { pseudonymityMode: 'per-reply', safeForWork: true }, challenges: [{ pendingApproval: true }], rules: ['Stay on topic.'] }
  return { board, file, entry, message, signature, directory, unmet: unmetOf(directory.requirements, record), signed: { file, entry, message, signature, publicKey: board.address } }
}

describe('the request for 5chan', () => {
  it('names the directory, the board, the entry to add and the signed message, and says the board meets the requirements', async () => {
    const f = await fixture({ owner: 'me.bso' })
    const { title, body } = requestOf({ family: '5chan', directory: f.directory, address: 'music.bso', signed: f.signed, unmet: f.unmet })
    expect(title).toBe('Add a board to /a/ - Anime & Manga: music.bso')
    expect(body).toContain('/a/ - Anime & Manga')
    expect(body).toContain('https://github.com/bitsocialnet/lists/blob/master/5chan-directories/5chan-a-directory.json')
    expect(body).toContain('Address: music.bso')
    expect(body).toContain(`Public key: ${f.board.address}`)
    expect(body).toContain('meets all 5 requirements')
    expect(body).toContain('add it to `boards`')
    expect(body).toContain(JSON.stringify(f.entry, null, 2))
    expect(body).toContain(`\`\`\`\n${f.message}\n\`\`\``)
    expect(body).toContain(`Signature (base64): ${f.signature}`)
    expect(body).toContain(`Verify: save the message above as msg.txt, then run: ${verifyCommand({ publicKey: f.board.address, signature: f.signature })}`)
    expect(body.split('\n').filter((line) => line.startsWith('Verify:'))).toHaveLength(1)
  })

  it('names each requirement a board misses, in words, and still says what the record is checked against', async () => {
    const f = await fixture({ record: { features: { pseudonymityMode: 'per-post' }, challenges: [], rules: [] } })
    const { body } = requestOf({ family: '5chan', directory: f.directory, address: 'music.bso', signed: f.signed, unmet: f.unmet })
    expect(f.unmet.length).toBeGreaterThan(2)
    expect(body).toContain(`misses ${String(f.unmet.length)} of 5 requirements`)
    expect(body).toContain('No poster IDs: every reply comes from a new address')
    expect(body).toContain('The board is marked safe for work')
    expect(body).not.toContain('meets all')
  })

  it('stays well under the length GitHub takes in an address, even for a board that misses every requirement', async () => {
    const f = await fixture({ owner: 'someone-with-a-long-name.bso', record: { features: {}, challenges: [], rules: [] } })
    const rich = { ...f.directory, requirements: requirementsOf({ features: { pseudonymityMode: 'per-reply', safeForWork: true, requirePostLinkIsMedia: true }, rules: Array.from({ length: 12 }, (_, i) => `Rule ${String(i)} with some words in it.`) }) }
    const unmet = unmetOf(rich.requirements, { features: {} })
    const { title, body } = requestOf({ family: '5chan', directory: rich, address: 'music.bso', signed: f.signed, unmet })
    expect(issueUrl({ title, body }).length).toBeLessThan(5500)
  })
})

describe('the request for seedit', () => {
  it('is the entry and the signed message to paste into seedit\'s own issue, naming the route, with no check of requirements', async () => {
    const f = await fixture({ file: 'seedit-directories/seedit-cats-directory.json' })
    const directory = directoriesOf('seedit', DEFAULTS_SEEDIT)[1]!
    const { title, body } = requestOf({ family: 'seedit', directory, address: 'music.bso', signed: f.signed, unmet: [] })
    expect(title).toBe('Propose a community for s/cats: music.bso')
    expect(body).toContain('s/cats')
    expect(body).toContain('add it to `communities`')
    expect(body).toContain('blob/master/seedit-directories/seedit-cats-directory.json')
    expect(body).toContain(JSON.stringify(f.entry, null, 2))
    expect(body).toContain(`Signature (base64): ${f.signature}`)
    expect(body).not.toContain('requirements')
  })
})

describe('the line that verifies the signature', () => {
  it('prints true for the signed message in a file, from the board\'s address alone, and false for any change', async () => {
    const f = await fixture({ owner: 'me.bso' })
    const dir = await mkdtemp(join(tmpdir(), 'bitsocial-listing-verify-'))
    try {
      const run = (text: string, signature = f.signature, publicKey = f.board.address) => {
        const file = join(dir, 'msg.txt')
        return writeFile(file, text).then(() => execFileSync(process.execPath, ['-e', VERIFY_SCRIPT, publicKey, signature, file], { encoding: 'utf8' }).trim())
      }
      expect(await run(f.message)).toBe('true')
      expect(await run(`${f.message}\n`)).toBe('true')
      expect(await run(f.message.replace('music.bso', 'other.bso'))).toBe('false')
      expect(await run(f.message, f.signature, (await key()).address)).toBe('false')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it.skipIf(process.platform === 'win32')('works as the line itself, typed into a shell', async () => {
    const f = await fixture()
    const dir = await mkdtemp(join(tmpdir(), 'bitsocial-listing-shell-'))
    try {
      await writeFile(join(dir, 'msg.txt'), f.message)
      const line = verifyCommand({ publicKey: f.board.address, signature: f.signature })
      expect(line.split('\n')).toHaveLength(1)
      expect(execFileSync('sh', ['-c', line], { cwd: dir, encoding: 'utf8' }).trim()).toBe('true')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('uses no character a shell would act on inside its double quotes', () => {
    expect(VERIFY_SCRIPT).not.toMatch(/["`$\\!]/)
  })
})

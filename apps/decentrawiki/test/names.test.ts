import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpnsError, createRecord, encodeKeyFile, generateNameKey, nameOf, parseName, verifyRecord } from '../page/src/ipfs/ipns.js'

// An in-memory store: the settings and the wikis, as the page keeps them.
const settings = new Map<string, unknown>()
const wikis = new Map<string, Record<string, unknown>>()
vi.mock('../page/src/store.js', () => ({
  getSetting: async (key: string, fallback: unknown) => settings.has(key) ? structuredClone(settings.get(key)) : fallback,
  setSetting: async (key: string, value: unknown) => { settings.set(key, structuredClone(value)) },
  updateSetting: async (key: string, fallback: unknown, change: (current: unknown) => unknown) => {
    const next = change(settings.has(key) ? structuredClone(settings.get(key)) : fallback)
    settings.set(key, structuredClone(next))
    return next
  },
  listWikis: async () => [...wikis.values()].map((wiki) => structuredClone(wiki)),
  getWiki: async (id: string) => structuredClone(wikis.get(id)),
  putWiki: async (wiki: { id: string }) => { wikis.set(wiki.id, structuredClone(wiki) as Record<string, unknown>) },
  updateWiki: async (id: string, change: (wiki: Record<string, unknown>) => Record<string, unknown>) => {
    const current = wikis.get(id)
    if (current === undefined) return undefined
    const next = change(structuredClone(current))
    wikis.set(id, next)
    return structuredClone(next)
  },
  replaceTiddlers: async () => {},
  getTiddlers: async () => [],
  askToPersist: async () => true
}))

const { LINEAGE, prepareImport } = await import('../page/src/import.js')
const { KEY_FILE_FORMAT, fromHex, keyFileName, keyFileText, looksLikeKey, readKeyFile, recordBytes, recordFileName, toBase64, toHex } = await import('../page/src/name-files.js')
const names = await import('../page/src/names.js')
const { pointName, sendSavedRecord } = await import('../page/src/publish/name-step.js')
const { addressToLink } = await import('../page/src/ui/confirm-import.js')
const { backup, lineageTiddler, linkWikiToName, restore, unlinkName } = await import('../page/src/wikis.js')

type NameEntry = import('../page/src/names.js').NameEntry

const CID_A = 'bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am'
const CID_B = 'bafkreigkgwdvr5wspzwpiutssn4xpj2i7wedshnwphhnu7ohx4pqaxxipe'
const NOW = Date.parse('2026-10-26T22:00:00Z')
const RELAY = 'https://pin.example/decentrawiki'
// Kubo 0.43.1: `ipfs key gen --type=ed25519`, with the name printed for it in base36 and in base32.
const KUBO_NAME = 'k51qzi5uqu5dgh3vf75s4r3b1tmvxytqag9c97dmnqy75fs1vlne9ovykd6tuy'
const KUBO_BASE32 = 'bafzaajaiaejcac5y7rmhk67f2nznpoky2busr7hzty4x54mf3xkdnaebvlg2zonk'
const KUBO_KEY_FILE = 'CAESQD3Huwe5KhRAWD+U8NOe5e4jWM3/CnpF5bXo/SMDpJeNC7j8WHV75dNy17lY0Gko/PmeOX7xhd3UNoCBqs2suao='
// The PEM armour is put together here so that check:secrets keeps flagging a real key block written out in full.
const ARMOUR = ['-----BEGIN', '-----END'].map((edge) => `${edge} PRIVATE KEY-----`)
const KUBO_PEM = `${ARMOUR[0]}\nMC4CAQAwBQYDK2VwBCIEID3Huwe5KhRAWD+U8NOe5e4jWM3/CnpF5bXo/SMDpJeN\n${ARMOUR[1]}\n`
const encoder = new TextEncoder()

beforeEach(() => {
  settings.clear()
  wikis.clear()
})

async function heldName (label = 'Bisq Wiki'): Promise<NameEntry> {
  return await names.makeName(label, NOW)
}

function wiki (id: string, name: string | null): Record<string, unknown> {
  return { id, title: id, subtitle: '', createdAt: 1, updatedAt: 1, source: { kind: 'new', at: 1 }, lineage: id, previous: null, name, publications: [] }
}

describe('the key file', () => {
  it('is written with the key, the address and every version, and read back to the same key', async () => {
    const entry = await heldName('Bisq Wiki')
    await names.signVersion(entry.name, { cid: CID_A, title: 'Bisq Wiki', now: NOW })
    await names.signVersion(entry.name, { cid: CID_B, title: 'Bisq Wiki 2', now: NOW + 60_000 })
    const held = (await names.getName(entry.name)) as NameEntry
    const file = JSON.parse(keyFileText(held))
    expect(file).toMatchObject({ format: KEY_FILE_FORMAT, version: 1, name: entry.name, address: `ipns://${entry.name}/`, wiki: 'Bisq Wiki' })
    expect(file.published).toEqual([
      { cid: CID_A, at: new Date(NOW).toISOString(), sequence: Math.floor(NOW / 1000), title: 'Bisq Wiki' },
      { cid: CID_B, at: new Date(NOW + 60_000).toISOString(), sequence: Math.floor(NOW / 1000) + 60, title: 'Bisq Wiki 2' }
    ])
    expect(file.note).toContain(`jq -r .privateKey ${keyFileName(held)} | base64 -d > ${entry.name}.key && ipfs key import`)
    expect(keyFileName(held)).toBe('bisq-wiki-address-key.json')
    expect(recordFileName(held)).toBe(`${entry.name}.ipns-record`)

    const read = await readKeyFile(encoder.encode(keyFileText(held)))
    expect(read.name).toBe(entry.name)
    expect(toHex(read.seed)).toBe(held.seed)
    expect(read.label).toBe('Bisq Wiki')
    expect(read.history.map((version) => [version.cid, version.sequence, version.title, version.at])).toEqual([
      [CID_A, Math.floor(NOW / 1000), 'Bisq Wiki', NOW], [CID_B, Math.floor(NOW / 1000) + 60, 'Bisq Wiki 2', NOW + 60_000]
    ])
  })

  it('writes a private key Kubo imports as it is', async () => {
    const entry = await heldName()
    const file = JSON.parse(keyFileText(entry))
    const { publicKey } = parseName(entry.name)
    expect(file.privateKey).toBe(toBase64(encodeKeyFile(fromHex(entry.seed), publicKey)))
  })

  it('reads a Kubo key file and Kubo\'s PEM, which carry no history', async () => {
    const fromKubo = await readKeyFile(new Uint8Array(Buffer.from(KUBO_KEY_FILE, 'base64')))
    expect(fromKubo).toMatchObject({ name: KUBO_NAME, label: '', history: [] })
    const fromPem = await readKeyFile(encoder.encode(KUBO_PEM))
    expect(fromPem.name).toBe(KUBO_NAME)
    expect(toHex(fromPem.seed)).toBe(toHex(fromKubo.seed))
  })

  it('refuses a JSON file of another kind, a key that is not the address named, and a damaged key, in words', async () => {
    const entry = await heldName()
    const good = JSON.parse(keyFileText(entry))
    const refusal = async (value: unknown) => await readKeyFile(encoder.encode(typeof value === 'string' ? value : JSON.stringify(value))).then(() => null, (error: unknown) => error as IpnsError)
    expect((await refusal({ a: 1 }))?.message).toContain('not a DecentraWiki address key')
    expect((await refusal({ ...good, version: 2 }))?.message).toContain('not a DecentraWiki address key')
    expect((await refusal('{"format": '))?.message).toContain('not a DecentraWiki address key')
    expect((await refusal({ ...good, name: KUBO_NAME }))?.kind).toBe('mismatch')
    expect((await refusal({ ...good, privateKey: 'AAAA' }))).toBeInstanceOf(IpnsError)
    expect((await refusal({ ...good, privateKey: '***' }))?.kind).toBe('malformed')
    expect(await readKeyFile(new Uint8Array(0)).catch((error: unknown) => (error as IpnsError).kind)).toBe('malformed')
  })

  it('ignores a history line it cannot trust', async () => {
    const entry = await heldName()
    const good = JSON.parse(keyFileText(entry))
    const history = [{ cid: CID_A, at: '2026-10-26T22:00:00.000Z', sequence: 4, title: 'A' }, { cid: 'nope', at: '2026-10-26T22:00:00.000Z', sequence: 5, title: 'B' }, { cid: CID_B, at: 'yesterday', sequence: 6, title: 'C' }, { cid: CID_B, at: '2026-10-26T22:00:00.000Z', sequence: -1, title: 'D' }]
    const read = await readKeyFile(encoder.encode(JSON.stringify({ ...good, published: history })))
    expect(read.history.map((version) => version.title)).toEqual(['A'])
  })

  it('tells a key file from a wiki file by its name or its first bytes', () => {
    expect(looksLikeKey('x.key', encoder.encode('binary'))).toBe(true)
    expect(looksLikeKey('x.PEM', encoder.encode(''))).toBe(true)
    expect(looksLikeKey('whatever', encoder.encode(KUBO_PEM))).toBe(true)
    expect(looksLikeKey('k.json', encoder.encode(`{\n "format": "${KEY_FILE_FORMAT}"`))).toBe(true)
    expect(looksLikeKey('wiki.json', encoder.encode('[{"title":"A"}]'))).toBe(false)
    expect(looksLikeKey('wiki.html', encoder.encode('<!doctype html>'))).toBe(false)
  })
})

describe('the sequence of a record', () => {
  it('is the clock in seconds, and never behind the last one signed', () => {
    expect(names.nextSequence({ sequence: -1 }, NOW)).toBe(Math.floor(NOW / 1000))
    expect(names.nextSequence({ sequence: 5 }, NOW)).toBe(Math.floor(NOW / 1000))
    const ahead = Math.floor(NOW / 1000) + 500
    expect(names.nextSequence({ sequence: ahead }, NOW)).toBe(ahead + 1)
  })

  it('moves forward for a key used from two browsers', async () => {
    const entry = await heldName()
    const first = await names.signVersion(entry.name, { cid: CID_A, title: 'A', now: NOW })
    const sibling = await names.signVersion(entry.name, { cid: CID_B, title: 'B', now: NOW - 3_600_000 })
    expect(sibling.sequence).toBe(first.sequence + 1)
    await names.raiseSequence(entry.name, first.sequence + 1000)
    const later = await names.signVersion(entry.name, { cid: CID_A, title: 'A', now: NOW })
    expect(later.sequence).toBe(first.sequence + 1001)
  })

  it('reads a sequence back as a time only when a clock made it', () => {
    expect(names.sequenceTime(Math.floor(NOW / 1000), NOW)).toBe(Math.floor(NOW / 1000) * 1000)
    expect(names.sequenceTime(7, NOW)).toBeNull()
    expect(names.sequenceTime(Math.floor(NOW / 1000) + 10 * 86_400, NOW)).toBeNull()
  })
})

describe('signing a version', () => {
  it('writes a record Kubo would accept: /ipfs/<cid>, ten years of validity, five minutes of TTL', async () => {
    const entry = await heldName()
    const { bytes, sequence } = await names.signVersion(entry.name, { cid: CID_A, title: 'A', now: NOW })
    const record = await verifyRecord(bytes, entry.name, { now: NOW })
    expect(record.value).toBe(`/ipfs/${CID_A}`)
    expect(record.sequence).toBe(sequence)
    expect(record.ttlMs).toBe(300_000)
    expect(record.validUntil).toBe(NOW + 3650 * 86_400_000)
    const held = (await names.getName(entry.name)) as NameEntry
    expect(held).toMatchObject({ sequence, accepted: false, keptUntil: null })
    expect(recordBytes(held)).toEqual(bytes)
    expect(held.history).toEqual([{ cid: CID_A, at: NOW, sequence, title: 'A' }])
  })

  it('sends the same record again for the same version, and a new one for the next', async () => {
    const entry = await heldName()
    const first = await names.signVersion(entry.name, { cid: CID_A, title: 'A', now: NOW })
    const again = await names.signVersion(entry.name, { cid: CID_A, title: 'A', now: NOW + 5000 })
    expect(again.sequence).toBe(first.sequence)
    expect(again.bytes).toEqual(first.bytes)
    const next = await names.signVersion(entry.name, { cid: CID_B, title: 'B', now: NOW + 9000 })
    expect(next.sequence).toBeGreaterThan(first.sequence)
    expect(((await names.getName(entry.name)) as NameEntry).history).toHaveLength(2)
  })

  it('does not sign for a key this browser does not hold', async () => {
    await expect(names.signVersion(KUBO_NAME, { cid: CID_A, title: 'A' })).rejects.toThrow('does not hold the key')
  })

  it('notes that Orivon\'s node took a record only while it is still the newest', async () => {
    const entry = await heldName()
    const first = await names.signVersion(entry.name, { cid: CID_A, title: 'A', now: NOW })
    const second = await names.signVersion(entry.name, { cid: CID_B, title: 'B', now: NOW + 1000 })
    await names.markKept(entry.name, first.sequence, NOW + 1e9)
    expect(((await names.getName(entry.name)) as NameEntry).accepted).toBe(false)
    await names.markKept(entry.name, second.sequence, NOW + 2e9)
    expect(await names.getName(entry.name)).toMatchObject({ accepted: true, keptUntil: NOW + 2e9 })
  })
})

describe('what an address is doing', () => {
  const base = { name: KUBO_NAME, seed: '00'.repeat(32), label: 'L', createdAt: 0, sequence: -1, record: null, accepted: false, keptUntil: null, history: [] } as NameEntry

  it('is told from the record and Orivon\'s answer', () => {
    expect(names.keepState(base, NOW)).toEqual({ kind: 'unpublished', until: null })
    expect(names.keepState({ ...base, record: 'AA==' }, NOW)).toEqual({ kind: 'unconfirmed', until: null })
    expect(names.keepState({ ...base, record: 'AA==', accepted: true, keptUntil: NOW + 1000 }, NOW)).toEqual({ kind: 'kept', until: NOW + 1000 })
    expect(names.keepState({ ...base, record: 'AA==', accepted: true, keptUntil: NOW - 1000 }, NOW)).toEqual({ kind: 'lapsed', until: NOW - 1000 })
  })

  it('offers to send the record again when Orivon\'s node has not taken it or has stopped keeping it', () => {
    expect(names.canKeepAgain(base, NOW)).toBe(false)
    expect(names.canKeepAgain({ ...base, record: 'AA==' }, NOW)).toBe(true)
    expect(names.canKeepAgain({ ...base, record: 'AA==', accepted: true, keptUntil: NOW + 1 }, NOW)).toBe(false)
    expect(names.canKeepAgain({ ...base, record: 'AA==', accepted: true, keptUntil: NOW - 1 }, NOW)).toBe(true)
  })

  it('shows the title of the last version, else the wiki it was made for', () => {
    expect(names.shownTitle(base)).toBe('L')
    expect(names.shownTitle({ ...base, history: [{ cid: CID_A, at: 1, sequence: 1, title: 'First' }, { cid: CID_B, at: 2, sequence: 2, title: 'Second' }] })).toBe('Second')
    expect(names.shownTitle({ ...base, label: '' })).toBe('an untitled wiki')
  })

  it('merges two histories once each, oldest first', () => {
    const one = { cid: CID_A, at: 1, sequence: 1, title: 'A' }
    const two = { cid: CID_B, at: 2, sequence: 2, title: 'B' }
    expect(names.mergeHistory([two], [one, two])).toEqual([one, two])
  })
})

describe('the addresses Publish offers', () => {
  const entry = (name: string) => ({ name }) as NameEntry

  it('defaults to updating the wiki\'s own address when this browser holds its key', () => {
    const choices = names.addressChoices({ name: 'k-own' }, [entry('k-own'), entry('k-other')])
    expect(choices.first).toBe('update')
    expect(choices.own?.name).toBe('k-own')
    expect(choices.others.map((held) => held.name)).toEqual(['k-other'])
    expect(choices.lost).toBeNull()
  })

  it('defaults to a new address for a wiki with no address, and lists the ones held', () => {
    expect(names.addressChoices({ name: null }, [entry('k-a')])).toMatchObject({ first: 'new', own: undefined, lost: null, others: [{ name: 'k-a' }] })
    expect(names.addressChoices({}, []).first).toBe('new')
  })

  it('shows an address whose key this browser does not hold as lost, and defaults to a new one', () => {
    expect(names.addressChoices({ name: 'k-gone' }, [entry('k-a')])).toMatchObject({ first: 'new', own: undefined, lost: 'k-gone' })
  })
})

describe('keeping keys', () => {
  it('keeps an imported key once, with the history of the file added to what is held', async () => {
    const { seed, publicKey } = await generateNameKey()
    const version = (cid: string, sequence: number) => ({ cid, at: NOW, sequence, title: `T${sequence}` })
    const first = await names.importKey({ seed, publicKey, label: 'From a file', history: [version(CID_A, 4)] }, NOW)
    expect(first.existed).toBe(false)
    expect(first.entry).toMatchObject({ name: nameOf(publicKey), label: 'From a file', sequence: 4, record: null })
    await names.signVersion(first.entry.name, { cid: CID_B, title: 'Mine', now: NOW })
    const second = await names.importKey({ seed, publicKey, label: 'Another label', history: [version(CID_A, 4), version(CID_B, 9)] }, NOW)
    expect(second.existed).toBe(true)
    expect(second.entry.label).toBe('From a file')
    expect(second.entry.record).not.toBeNull()
    expect(second.entry.history.map((v) => `${v.cid}:${v.title}`).sort()).toEqual([`${CID_A}:T4`, `${CID_B}:Mine`, `${CID_B}:T9`].sort())
    expect(await names.loadNames()).toHaveLength(1)
  })

  it('removes a key from this browser', async () => {
    const entry = await heldName()
    await names.removeName(entry.name)
    expect(await names.loadNames()).toEqual([])
  })

  it('skips stored entries it cannot use', async () => {
    const entry = await heldName()
    settings.set('names', [entry, { name: 'nope', seed: '00' }, null, { ...entry, name: 'k51damaged' }])
    expect((await names.loadNames()).map((held) => held.name)).toEqual([entry.name])
  })
})

describe('pointing an address at a version', () => {
  it('signs, sends the record to Orivon\'s node and notes that it kept it', async () => {
    const entry = await heldName()
    const sent: { url: string, type: string | null, body: Uint8Array }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, type: new Headers(init.headers).get('content-type'), body: init.body as Uint8Array })
      return Response.json({ Name: entry.name, Value: `/ipfs/${CID_A}`, Sequence: Math.floor(NOW / 1000), KeptUntil: '2026-11-25T22:00:00.000Z' })
    }) as unknown as typeof fetch
    const result = await pointName({ name: entry.name, cid: CID_A, title: 'A', send: true, endpoint: RELAY, fetchImpl, now: NOW })
    expect(result).toEqual({ sequence: Math.floor(NOW / 1000), keptUntil: Date.parse('2026-11-25T22:00:00.000Z'), problem: null })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe(`${RELAY}/api/v0/name/keep?arg=${entry.name}`)
    expect(sent[0]?.type).toBe('application/vnd.ipfs.ipns-record')
    expect(await names.getName(entry.name)).toMatchObject({ accepted: true, keptUntil: Date.parse('2026-11-25T22:00:00.000Z') })
    expect(sent[0]?.body).toEqual(recordBytes((await names.getName(entry.name)) as NameEntry))
  })

  it('keeps the publish standing when the relay refuses: the record is saved, its words come back, and a retry sends the same record', async () => {
    const entry = await heldName()
    const refuse = (async () => Response.json({ Message: 'That version is not a DecentraWiki wiki, so Orivon\'s node will not keep an address for it.', Code: 0, Type: 'error' }, { status: 409 })) as unknown as typeof fetch
    const failed = await pointName({ name: entry.name, cid: CID_A, title: 'A', send: true, endpoint: RELAY, fetchImpl: refuse, now: NOW })
    expect(failed).toEqual({ sequence: Math.floor(NOW / 1000), keptUntil: null, problem: 'That version is not a DecentraWiki wiki, so Orivon\'s node will not keep an address for it.' })
    const saved = (await names.getName(entry.name)) as NameEntry
    expect(saved).toMatchObject({ accepted: false, sequence: Math.floor(NOW / 1000) })
    const ok = (async () => Response.json({ Name: entry.name, Value: `/ipfs/${CID_A}`, Sequence: Math.floor(NOW / 1000), KeptUntil: '2026-11-25T22:00:00.000Z' })) as unknown as typeof fetch
    const retry = await pointName({ name: entry.name, cid: CID_A, title: 'A', send: true, endpoint: RELAY, fetchImpl: ok, now: NOW + 60_000 })
    expect(retry.sequence).toBe(failed.sequence)
    expect(retry.problem).toBeNull()
    expect((await names.getName(entry.name) as NameEntry).history).toHaveLength(1)
  })

  it('signs and saves the record without calling the relay for a download', async () => {
    const entry = await heldName()
    const fetchImpl = vi.fn()
    const result = await pointName({ name: entry.name, cid: CID_A, title: 'A', send: false, endpoint: RELAY, fetchImpl: fetchImpl as unknown as typeof fetch, now: NOW })
    expect(result).toEqual({ sequence: Math.floor(NOW / 1000), keptUntil: null, problem: null })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(((await names.getName(entry.name)) as NameEntry).record).not.toBeNull()
  })

  it('does not take an answer about another record for the one sent', async () => {
    const entry = await heldName()
    await names.signVersion(entry.name, { cid: CID_A, title: 'A', now: NOW })
    const other = (async () => Response.json({ Name: entry.name, Value: `/ipfs/${CID_B}`, Sequence: Math.floor(NOW / 1000), KeptUntil: '2026-11-25T22:00:00.000Z' })) as unknown as typeof fetch
    await expect(sendSavedRecord({ name: entry.name, endpoint: RELAY, fetchImpl: other })).rejects.toThrow('different record')
    expect(((await names.getName(entry.name)) as NameEntry).accepted).toBe(false)
  })

  it('says so when there is no record to send, and when the key is not held', async () => {
    const entry = await heldName()
    await expect(sendSavedRecord({ name: entry.name, endpoint: RELAY })).rejects.toThrow('no record to send')
    const result = await pointName({ name: KUBO_NAME, cid: CID_A, title: 'A', send: true, endpoint: RELAY })
    expect(result.sequence).toBeNull()
    expect(result.problem).toContain('does not hold the key')
  })
})

describe('the lineage a published copy carries', () => {
  const published = { id: 'w1', title: 'W', lineage: 'abcdefgh12345', previous: null, publications: [{ cid: CID_A, at: 1, target: 't', size: 1 }] } as never

  it('carries the address when the version has one, and leaves it out without', () => {
    expect(JSON.parse(lineageTiddler(published, KUBO_NAME).text)).toEqual({ id: 'abcdefgh12345', previous: `ipfs://${CID_A}`, name: KUBO_NAME })
    expect(JSON.parse(lineageTiddler(published).text)).toEqual({ id: 'abcdefgh12345', previous: `ipfs://${CID_A}` })
    expect(JSON.parse(lineageTiddler(published, null).text)).not.toHaveProperty('name')
    expect(lineageTiddler(published, KUBO_NAME)).toMatchObject({ title: LINEAGE, type: 'application/json' })
  })

  it('is read back with its address, a missing one, or one that is not an address dropped', () => {
    const lineageOf = (value: unknown) => prepareImport([{ title: LINEAGE, text: JSON.stringify(value) }, { title: 'A' }]).lineage
    expect(lineageOf({ id: 'abcdefgh12345', previous: `ipfs://${CID_A}`, name: KUBO_NAME })).toEqual({ id: 'abcdefgh12345', previous: `ipfs://${CID_A}`, name: KUBO_NAME })
    expect(lineageOf({ id: 'abcdefgh12345', previous: null })).toEqual({ id: 'abcdefgh12345', previous: null })
    expect(lineageOf({ id: 'abcdefgh12345', previous: null, name: 'ipfs://not-a-name' })).toEqual({ id: 'abcdefgh12345', previous: null })
    expect(lineageOf({ id: 'abcdefgh12345', previous: null, name: 7 })).toEqual({ id: 'abcdefgh12345', previous: null })
    expect(lineageOf({ id: 'abcdefgh12345', previous: null, name: CID_A })).toEqual({ id: 'abcdefgh12345', previous: null })
  })

  it('reads the address in any form a name has, as the name Kubo prints', () => {
    const lineage = prepareImport([{ title: LINEAGE, text: JSON.stringify({ id: 'abcdefgh12345', previous: null, name: KUBO_BASE32 }) }, { title: 'A' }]).lineage
    expect(lineage?.name).toBe(KUBO_NAME)
  })
})

describe('linking a wiki to its address', () => {
  it('gives an address to one wiki at a time', async () => {
    wikis.set('a', wiki('a', KUBO_NAME))
    wikis.set('b', wiki('b', null))
    await linkWikiToName('b', KUBO_NAME)
    expect(wikis.get('a')?.['name']).toBeNull()
    expect(wikis.get('b')?.['name']).toBe(KUBO_NAME)
    await unlinkName(KUBO_NAME)
    expect(wikis.get('b')?.['name']).toBeNull()
  })

  it('links a wiki taken in only to an address whose key this browser holds', async () => {
    const entry = await heldName()
    const prepared = (name: string | undefined) => prepareImport([{ title: LINEAGE, text: JSON.stringify({ id: 'abcdefgh12345', previous: null, ...(name ? { name } : {}) }) }, { title: 'A' }])
    expect(await addressToLink(null, prepared(entry.name))).toBe(entry.name)
    expect(await addressToLink(null, prepared(KUBO_NAME))).toBeNull()
    expect(await addressToLink(null, prepared(undefined))).toBeNull()
    expect(await addressToLink(entry.name, prepared(KUBO_NAME))).toBe(entry.name)
    expect(await addressToLink(KUBO_NAME, prepared(entry.name))).toBe(entry.name)
    expect(await addressToLink(KUBO_NAME, prepared(KUBO_NAME))).toBeNull()
  })
})

describe('backup and restore', () => {
  it('keep each wiki\'s address and the one each version went under, and hold no key', async () => {
    const entry = await heldName()
    await names.signVersion(entry.name, { cid: CID_A, title: 'A', now: NOW })
    wikis.set('w1', { ...wiki('w1', entry.name), publications: [{ cid: CID_A, at: NOW, target: 't', size: 5, name: entry.name, sequence: 42 }] })
    const text = await backup()
    expect(text).not.toContain(entry.seed)
    expect(text).not.toContain('privateKey')
    const parsed = JSON.parse(text)
    expect(parsed.wikis[0].wiki.name).toBe(entry.name)

    wikis.clear()
    expect(await restore(parsed.wikis.map((item: { wiki: object, tiddlers: object[] }) => ({ ...item, tiddlers: [{ title: 'A', text: 'a' }] })))).toBe(1)
    expect(wikis.get('w1')?.['name']).toBe(entry.name)
    expect((wikis.get('w1')?.['publications'] as object[])[0]).toMatchObject({ cid: CID_A, name: entry.name, sequence: 42 })
  })

  it('drops an address that is not a name, and reads a backup that has none', async () => {
    const entries = ['not a name', 7, undefined, KUBO_BASE32].map((name, index) => ({
      wiki: { ...wiki(`w${index}`, null), ...(name === undefined ? {} : { name }), publications: [{ cid: CID_A, at: 1, target: 't', size: 1, name: 'junk', sequence: 3 }] },
      tiddlers: [{ title: 'A', text: 'a' }]
    }))
    expect(await restore(entries)).toBe(4)
    expect([0, 1, 2, 3].map((index) => wikis.get(`w${index}`)?.['name'])).toEqual([null, null, null, KUBO_NAME])
    expect((wikis.get('w0')?.['publications'] as object[])[0]).not.toHaveProperty('name')
  })
})

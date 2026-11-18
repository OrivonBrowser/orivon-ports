// What the node knows of giving a board a name: the name as ENS spells it, the record the name must hold, the calldata of the
// transaction that sets it (against an encoding worked out by hand from the ABI), the way pkc-js's own name resolvers are asked
// whether the name points at the board, and where the name's resolver contract is read from.
import { describe, expect, it, vi } from 'vitest'
import { checkName, ensNameOf, ethereumReader, isBoardKey, nameClaims, NameClaimError, recordOf, RECORD_KEY, setTextData } from '../worker/name-claim.js'

const KEY = '12D3KooWJoFVU6rBeqCTZoPszCaWyENY5ahrTUsNpHqhfrpmwkZD'
const OTHER = '12D3KooWGuT5qwpG6eAiavrAoTiXKyb2UL12NvoWAEVT9CLBZoLN'
/** The namehash of `foo.eth`, which ENS's own documentation lists. */
const FOO_ETH = '0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f'
/** `setText(bytes32,string,string)`, the PublicResolver's selector. */
const SET_TEXT = '10f13a8c'
const ZERO = '0x0000000000000000000000000000000000000000'
const RESOLVER = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63'

const word = (hex: string) => hex.padStart(64, '0')
const padded = (text: string) => Buffer.from(text).toString('hex').padEnd(Math.ceil(Buffer.byteLength(text) / 32) * 64, '0')

/** The calldata the ABI specification makes of `setText(node, key, value)`: a word for the node, one offset for each string, then each string's length and padded bytes. */
function byHand (node: string, key: string, value: string) {
  const keyOffset = 0x60
  const valueOffset = keyOffset + 32 + Math.ceil(Buffer.byteLength(key) / 32) * 32
  return `0x${SET_TEXT}${node.slice(2)}${word(keyOffset.toString(16))}${word(valueOffset.toString(16))}${word(Buffer.byteLength(key).toString(16))}${padded(key)}${word(Buffer.byteLength(value).toString(16))}${padded(value)}`
}

describe('the name as ENS spells it', () => {
  it('writes a .bso name as the .eth name it is, and keeps a .eth name', () => {
    expect(ensNameOf('yourname.bso')).toEqual({ name: 'yourname.bso', ensName: 'yourname.eth' })
    expect(ensNameOf('yourname.eth')).toEqual({ name: 'yourname.eth', ensName: 'yourname.eth' })
    expect(ensNameOf('board.yourname.bso').ensName).toBe('board.yourname.eth')
  })

  it('refuses what pkc-js or ENS would refuse: a capital letter, another ending, an empty label and a name ENS writes differently', () => {
    for (const bad of ['Yourname.bso', 'yourname.ETH', 'yourname.com', 'yourname', '.eth', '.bso', '..eth', 'a b.eth', 'ａ.eth', 'x'.repeat(260) + '.eth', '', 'yourname.bso.']) {
      expect(() => ensNameOf(bad), bad).toThrowError(NameClaimError)
      try { ensNameOf(bad) } catch (error) { expect((error as NameClaimError).status).toBe(400) }
    }
    expect(() => ensNameOf(42 as never)).toThrowError(NameClaimError)
  })
})

describe('the record', () => {
  it('is the text record `bitsocial` of the name, holding the board\'s public key', () => {
    expect(RECORD_KEY).toBe('bitsocial')
    expect(recordOf({ name: 'music.bso', publicKey: KEY })).toEqual({ name: 'music.bso', ensName: 'music.eth', key: 'bitsocial', value: KEY })
    expect(recordOf({ name: 'music.eth', publicKey: KEY }).ensName).toBe('music.eth')
  })

  it('is refused for a key the resolver would not read as a board\'s, so the person never sets a record that cannot work', () => {
    for (const bad of ['', 'abc', `${KEY}x`, KEY.slice(1), 'Qm' + 'a'.repeat(10), '12D3Koo0' + 'a'.repeat(44)]) {
      expect(() => recordOf({ name: 'music.bso', publicKey: bad }), bad).toThrowError(/not a key a name can hold/)
      try { recordOf({ name: 'music.bso', publicKey: bad }) } catch (error) { expect((error as NameClaimError).status).toBe(409) }
    }
    expect(isBoardKey(KEY)).toBe(true)
    expect(isBoardKey(`Qm${'a'.repeat(44)}`)).toBe(true)
    expect(isBoardKey(KEY.toLowerCase())).toBe(false)
  })
})

describe('the transaction\'s calldata', () => {
  it('is setText(namehash, "bitsocial", the key), as the ABI lays it out', () => {
    const data = setTextData({ ensName: 'foo.eth', value: KEY })
    expect(KEY).toHaveLength(52)
    expect(data).toBe(byHand(FOO_ETH, 'bitsocial', KEY))
    expect(data.startsWith(`0x${SET_TEXT}${FOO_ETH.slice(2)}`)).toBe(true)
  })

  it('lays out the offsets, the lengths and the padding as written, for a fixture name', () => {
    expect(setTextData({ ensName: 'foo.eth', value: KEY })).toBe(
      '0x10f13a8c' + FOO_ETH.slice(2) +
      '0000000000000000000000000000000000000000000000000000000000000060' +
      '00000000000000000000000000000000000000000000000000000000000000a0' +
      '0000000000000000000000000000000000000000000000000000000000000009' +
      '626974736f6369616c'.padEnd(64, '0') +
      '0000000000000000000000000000000000000000000000000000000000000034' +
      Buffer.from(KEY).toString('hex').padEnd(128, '0')
    )
  })

  it('names the node of a name with a sub-name by its own namehash', () => {
    const sub = setTextData({ ensName: 'board.foo.eth', value: OTHER })
    expect(sub.slice(10, 74)).not.toBe(FOO_ETH.slice(2))
    expect(sub).toMatch(/^0x10f13a8c[0-9a-f]+$/)
    expect(sub).toHaveLength(2 + 8 + 64 * 3 + 64 + 64 + 64 + 128)
  })
})

/** A name resolver as pkc-js holds one: `canResolve`, `resolve`, a key and its provider. */
function resolver (key: string, answer: () => unknown, over: { can?: boolean, provider?: string } = {}) {
  const resolve = vi.fn(async (_options: { name: string, abortSignal?: AbortSignal }) => { const value = answer(); return value as { publicKey: string } | undefined })
  return { key, provider: over.provider ?? `https://${key}.test`, canResolve: () => over.can !== false, resolve }
}
const says = (publicKey: string) => () => ({ publicKey })
const refuses = (message: string) => () => { throw new Error(message) }

describe('the check, as pkc-js asks its name resolvers', () => {
  it('says the name points at the board when the first resolver that has a record gives the board\'s key', async () => {
    const first = resolver('one', says(KEY))
    const second = resolver('two', says(OTHER))
    const answer = await checkName({ name: 'music.bso', publicKey: KEY, resolvers: [first, second] })
    expect(answer).toMatchObject({ outcome: 'here', resolved: KEY, resolver: 'one' })
    expect(first.resolve.mock.calls[0]![0].name).toBe('music.bso')
    expect(second.resolve).not.toHaveBeenCalled()
  })

  it('says the name points at another board, and which', async () => {
    expect(await checkName({ name: 'music.bso', publicKey: KEY, resolvers: [resolver('one', says(OTHER))] })).toMatchObject({ outcome: 'elsewhere', resolved: OTHER })
  })

  it('says there is no record when the resolvers answered and none holds one, asking each in turn as pkc-js does', async () => {
    const resolvers = [resolver('one', () => undefined), resolver('two', () => undefined)]
    expect(await checkName({ name: 'music.bso', publicKey: KEY, resolvers })).toMatchObject({ outcome: 'none', resolved: null })
    expect(resolvers.map((one) => one.resolve.mock.calls.length)).toEqual([1, 1])
  })

  it('goes on to the next resolver when one fails, and still answers from the one that works', async () => {
    const answer = await checkName({ name: 'music.eth', publicKey: KEY, resolvers: [resolver('down', refuses('503 from the provider')), resolver('up', says(KEY))] })
    expect(answer).toMatchObject({ outcome: 'here', resolver: 'up' })
  })

  it('counts a failed resolver and an answer of "no record" as what they are: an answer from one is enough to say there is none', async () => {
    const answer = await checkName({ name: 'music.eth', publicKey: KEY, resolvers: [resolver('down', refuses('timeout')), resolver('up', () => undefined)] })
    expect(answer.outcome).toBe('none')
  })

  it('says it could not find out when every resolver failed, with a short reason for each and no address', async () => {
    const answer = await checkName({ name: 'music.eth', publicKey: KEY, resolvers: [resolver('one', refuses('connect failed\nURL: https://secret-key.example/v3/abcdef')), resolver('two', refuses('x'.repeat(500)))] })
    expect(answer.outcome).toBe('unreachable')
    expect(answer.errors).toEqual([{ resolver: 'one', message: 'connect failed' }, { resolver: 'two', message: 'x'.repeat(160) }])
    expect(JSON.stringify(answer)).not.toContain('secret-key')
  })

  it('says the record is not a board key when the resolvers refuse it as one', async () => {
    const answer = await checkName({ name: 'music.eth', publicKey: KEY, resolvers: [resolver('one', refuses('Invalid bitsocial TXT record: expected a valid IPNS public key as the first segment.'))] })
    expect(answer).toMatchObject({ outcome: 'invalid', resolved: null })
    expect(answer.errors?.[0]?.message).toContain('Invalid bitsocial TXT record')
  })

  it('says no resolver reads the name when none can handle it, or the node has none (a run with no internet)', async () => {
    expect((await checkName({ name: 'music.bso', publicKey: KEY, resolvers: [] })).outcome).toBe('no-resolver')
    expect((await checkName({ name: 'music.bso', publicKey: KEY, resolvers: [resolver('one', says(KEY), { can: false })] })).outcome).toBe('no-resolver')
  })

  it('gives a resolver that never answers a limited time, and goes on', async () => {
    const slow = { key: 'slow', provider: 'https://slow.test', canResolve: () => true, resolve: ({ abortSignal }: { abortSignal?: AbortSignal }) => new Promise((_resolve, reject) => { abortSignal?.addEventListener('abort', () => { reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })) }) }) }
    const answer = await checkName({ name: 'music.bso', publicKey: KEY, resolvers: [slow as never, resolver('up', says(KEY))], timeoutMs: 20 })
    expect(answer).toMatchObject({ outcome: 'here', resolver: 'up' })
  })

  it('asks the resolver a fresh question every time: nothing it said before is kept', async () => {
    const one = resolver('one', says(KEY))
    await checkName({ name: 'music.bso', publicKey: KEY, resolvers: [one] })
    await checkName({ name: 'music.bso', publicKey: KEY, resolvers: [one] })
    expect(one.resolve).toHaveBeenCalledTimes(2)
  })
})

const REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
interface Read { address: string, functionName: string, args: unknown[] }
/** A viem client for one provider, as far as the reader asks of it; `seen` collects what it is asked to read. */
const clientFor = (answers: Record<string, () => Promise<string>>, seen: Read[] = []) => vi.fn((url: string) => ({ readContract: async (read: Read) => { seen.push(read); const answer = answers[url]; if (answer === undefined) throw new Error(`no stand-in for ${url}`); return answer() } }))

describe('where the name\'s resolver contract is read', () => {
  it('asks the ENS registry for the resolver of the name\'s node, the providers in turn, the first that answers', async () => {
    const seen: Read[] = []
    const make = clientFor({ 'https://a.test': async () => { throw new Error('down') }, 'https://b.test': async () => RESOLVER }, seen)
    const reader = ethereumReader({ providers: ['https://a.test', 'https://b.test'], createClient: make as never })
    expect(await reader.resolverOf('foo.eth')).toBe(RESOLVER)
    expect(make.mock.calls.map((call) => call[0])).toEqual(['https://a.test', 'https://b.test'])
    expect(seen.map((read) => [read.address, read.functionName, read.args])).toEqual([[REGISTRY, 'resolver', [FOO_ETH]], [REGISTRY, 'resolver', [FOO_ETH]]])
  })

  it('reads the registry, not the universal resolver: the resolver that answers reads of a .eth name holds no records and has no setText', async () => {
    const seen: Read[] = []
    const client = (url: string) => ({
      getEnsResolver: async () => '0x394D8EB4a4fDF599384DeAb25F31d111d755c398',
      readContract: async (read: Read) => { seen.push(read); return RESOLVER }
    })
    const reader = ethereumReader({ providers: ['https://a.test'], createClient: client as never })
    expect(await reader.resolverOf('foo.eth')).toBe(RESOLVER)
    expect(seen).toHaveLength(1)
  })

  it('writes the name as ENS normalizes it, and answers null for a name that has no resolver, and throws when no provider answered', async () => {
    const seen: Read[] = []
    const make = clientFor({ 'https://a.test': async () => ZERO }, seen)
    expect(await ethereumReader({ providers: ['https://a.test'], createClient: make as never }).resolverOf('Foo.eth')).toBeNull()
    expect(seen[0]?.args).toEqual([FOO_ETH])
    const failing = ethereumReader({ providers: ['https://a.test', 'https://b.test'], createClient: clientFor({ 'https://a.test': async () => { throw new Error('down') }, 'https://b.test': async () => { throw new Error('also down') } }) as never })
    await expect(failing.resolverOf('foo.eth')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('any of the node\'s 2 providers') })
    // One provider is the node's own endpoint, which reads through the browser's light client and then the public servers: it is not told as a count.
    const one = ethereumReader({ providers: ['https://a.test'], createClient: clientFor({ 'https://a.test': async () => { throw new Error('down') } }) as never })
    await expect(one.resolverOf('foo.eth')).rejects.toMatchObject({ status: 502, message: 'Ethereum could not be read: down' })
  })

  it('reads no Ethereum at all when the node has no provider, and says so', async () => {
    await expect(ethereumReader({ providers: [], createClient: clientFor({}) as never }).resolverOf('foo.eth')).rejects.toMatchObject({ status: 503 })
  })
})

describe('the claims the node makes for a page', () => {
  const pkc = (resolvers: unknown[]) => ({ nameResolvers: resolvers })

  it('prepares the transaction: mainnet, the name\'s resolver, no value, and the calldata', async () => {
    const claims = nameClaims({ pkc: () => pkc([resolver('one', says(KEY), { provider: 'https://a.test' })]), createClient: clientFor({ 'https://a.test': async () => RESOLVER }) as never })
    expect(await claims.transaction({ name: 'foo.bso', publicKey: KEY })).toEqual({
      name: 'foo.bso', ensName: 'foo.eth', key: 'bitsocial', value: KEY, chainId: 1, transaction: { to: RESOLVER, data: byHand(FOO_ETH, 'bitsocial', KEY), value: '0x0' }
    })
  })

  it('refuses a transaction for a name with no resolver, with the way out in words', async () => {
    const claims = nameClaims({ pkc: () => pkc([resolver('one', says(KEY), { provider: 'https://a.test' })]), createClient: clientFor({ 'https://a.test': async () => ZERO }) as never })
    await expect(claims.transaction({ name: 'foo.bso', publicKey: KEY })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/no resolver.*name manager/s) })
  })

  it('reads the providers from the resolvers pkc-js holds, so it asks the ones the board is hosted with, and skips a socket address', async () => {
    const make = clientFor({ 'https://a.test': async () => RESOLVER })
    const claims = nameClaims({ pkc: () => pkc([resolver('ws', says(KEY), { provider: 'wss://ws.test' }), resolver('one', says(KEY), { provider: 'https://a.test' })]), createClient: make as never })
    await claims.transaction({ name: 'foo.bso', publicKey: KEY })
    expect(make.mock.calls.map((call) => call[0])).toEqual(['https://a.test'])
  })

  it('checks through pkc-js\'s own resolvers, and says no resolver while pkc-js is not up', async () => {
    const claims = nameClaims({ pkc: () => pkc([resolver('one', says(KEY))]), createClient: clientFor({}) as never })
    expect((await claims.check({ name: 'foo.bso', publicKey: KEY })).outcome).toBe('here')
    expect((await nameClaims({ pkc: () => null, createClient: clientFor({}) as never }).check({ name: 'foo.bso', publicKey: KEY })).outcome).toBe('no-resolver')
  })
})

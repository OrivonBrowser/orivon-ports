// The "Require an Orivon ID" challenge: which author names count as an ID, what a refused poster is told, and that the proof is pkc-js's own
// author-identity check (a name resolves, through its `bitsocial` text record, to the key that signed) with only the shape of the name added.
import { generateKeyPairSync } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import idChallenge, { DEFAULT_MESSAGE, NAME, orivonIdOf, PARENT, SITE } from '../orivon-id-challenge/index.js'

const NODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKC = join(NODE_DIR, 'node_modules', '@pkcprotocol', 'pkc-js', 'dist', 'node')
const { createAuthorIdentityMatcher } = await import(pathToFileURL(join(PKC, 'runtime', 'node', 'community', 'local-community', 'author-identity.js')).href) as { createAuthorIdentityMatcher: (options: Record<string, unknown>) => Matcher }
const { getPKCAddressFromPublicKeySync } = await import(pathToFileURL(join(PKC, 'signer', 'util.js')).href) as { getPKCAddressFromPublicKeySync: (key: string) => string }

interface Matcher { wireName: string | undefined, matchesIdentity: (name: string) => Promise<{ matched: boolean, nameFailure?: { reason: string } }> }

/** A key as a publication carries it: the 32 raw bytes of an ed25519 public key in base 64, and the address pkc-js derives from it. */
function signer () {
  const { x } = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' })
  const publicKey = Buffer.from(String(x), 'base64url').toString('base64')
  return { publicKey, address: getPKCAddressFromPublicKeySync(publicKey) }
}

/** pkc-js's real matcher for a publication, over a name resolution this test decides: an address, null (no record) or an error. */
function realMatcher (name: string | undefined, resolves: string | null | Error, key = signer()) {
  const resolve = vi.fn(async () => { if (resolves instanceof Error) throw resolves; return { resolvedAuthorName: resolves } })
  const community = { _clientsManager: { resolveAuthorNameIfNeeded: resolve }, _pkc: { _timeouts: { 'resolve-author-name': 1000 } } }
  const author = name === undefined ? {} : { name }
  return { matcher: createAuthorIdentityMatcher({ community, publication: { signature: { publicKey: key.publicKey }, author } }), resolve, key }
}

const ask = async (matcher: unknown, options: Record<string, unknown> = {}) => await idChallenge({ challengeSettings: { name: NAME, options } }).getChallenge({ challengeSettings: { name: NAME, options }, challengeRequestMessage: {}, authorIdentityMatcher: matcher as never })

describe('which author names are an Orivon ID', () => {
  it.each([
    ['alice.v1.orivonid.eth', 'alice'],
    ['ALICE.V1.OrivonID.ETH', 'alice'],
    ['alice.v1.orivonid.bso', 'alice'],
    ['a-b-c.v1.orivonid.eth', 'a-b-c'],
    ['0x1.v1.orivonid.eth', '0x1'],
    ['x'.repeat(63) + '.v1.orivonid.eth', 'x'.repeat(63)]
  ])('takes %s: the ID is the label', (name, label) => {
    expect(orivonIdOf(name)).toEqual({ label, name: `${label}.${PARENT}` })
  })

  it.each([
    ['no name at all', undefined],
    ['an empty string', ''],
    ['the registry itself', 'v1.orivonid.eth'],
    ['its parent', 'orivonid.eth'],
    ['a name one label deeper, which an ID holder can mint for themselves', 'bob.alice.v1.orivonid.eth'],
    ['a name that only ends like one', 'alice.v1.orivonid.eth.evil.eth'],
    ['a name that embeds one', 'v1.orivonid.eth.alice.eth'],
    ['a look-alike parent', 'alice.v1.orivonid.com'],
    ['a look-alike parent with another label', 'alice.v1.orivonld.eth'],
    ['a name in the other namespace Orivon opens, which no Bitsocial node can resolve', 'alice.orv'],
    ['a plain ENS name', 'alice.eth'],
    ['a label of two characters', 'ab.v1.orivonid.eth'],
    ['a label of 64 characters', 'x'.repeat(64) + '.v1.orivonid.eth'],
    ['a label that starts with a hyphen', '-ab.v1.orivonid.eth'],
    ['a label that ends with a hyphen', 'ab-.v1.orivonid.eth'],
    ['an empty label', '.v1.orivonid.eth'],
    ['a trailing dot', 'alice.v1.orivonid.eth.'],
    ['a trailing space', 'alice.v1.orivonid.eth '],
    ['a leading space', ' alice.v1.orivonid.eth'],
    ['a trailing newline', 'alice.v1.orivonid.eth\n'],
    ['a label with a letter outside a to z, such as a full-width one that ENS normalises to ASCII', 'ａlice.v1.orivonid.eth'],
    ['a label with a dotless i that upper-cases to I', 'alıce.v1.orivonid.eth'],
    ['a label with a space', 'al ice.v1.orivonid.eth'],
    ['a label with an underscore', 'al_ice.v1.orivonid.eth']
  ])('refuses %s', (_why, name) => {
    expect(orivonIdOf(name)).toBeNull()
  })

  it('takes only a string', () => {
    for (const odd of [null, 7, {}, ['alice.v1.orivonid.eth'], true]) expect(orivonIdOf(odd as never)).toBeNull()
  })
})

describe('what a refused poster is told', () => {
  it('is one sentence that says what to do and links the site', () => {
    expect(DEFAULT_MESSAGE).toContain(SITE)
    expect(SITE).toBe('https://id.orivonstack.eth')
    expect(DEFAULT_MESSAGE).toMatch(/^[^\n]+\.$/)
    expect(DEFAULT_MESSAGE).not.toMatch(/[.!?] [A-Z]/)
    expect(DEFAULT_MESSAGE).toMatch(/Orivon ID/)
    expect(DEFAULT_MESSAGE).toMatch(/"bitsocial" record/)
    expect(DEFAULT_MESSAGE.length).toBeLessThan(220)
  })
})

describe('a post checked against pkc-js\'s real author-identity matcher', () => {
  it('passes when the name is an ID that resolves to the key that signed, asking the resolvers once and never a cache', async () => {
    const { matcher, resolve, key } = realMatcher('alice.v1.orivonid.eth', 'placeholder')
    resolve.mockResolvedValue({ resolvedAuthorName: key.address })
    expect(await ask(matcher)).toEqual({ success: true })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ authorName: 'alice.v1.orivonid.eth', cache: { maxAge: 0 } }))
  })

  it('passes under the other spellings of the same name', async () => {
    for (const name of ['Alice.V1.Orivonid.ETH', 'alice.v1.orivonid.bso']) {
      const { matcher, resolve, key } = realMatcher(name, 'placeholder')
      resolve.mockResolvedValue({ resolvedAuthorName: key.address })
      expect(await ask(matcher), name).toEqual({ success: true })
    }
  })

  it('refuses a name that resolves to somebody else\'s key: an ID is shown by its record, not by being claimed', async () => {
    const { matcher } = realMatcher('alice.v1.orivonid.eth', signer().address)
    const result = await ask(matcher)
    expect(result.success).toBe(false)
    expect(result.error).toBe(`${DEFAULT_MESSAGE} That name's "bitsocial" record holds a different address.`)
    expect(result.reason).toBe(result.error)
  })

  it('refuses a name with no record, and says what pkc-js says of it', async () => {
    const { matcher } = realMatcher('alice.v1.orivonid.eth', null)
    const result = await ask(matcher)
    expect(result.success).toBe(false)
    expect(result.error).toBe(`${DEFAULT_MESSAGE} The author name has no text record, so it could not be verified against the publication signer`)
  })

  it('refuses when every resolver failed, and says the fault is not the poster\'s', async () => {
    const { matcher } = realMatcher('alice.v1.orivonid.eth', new Error('all resolvers failed'))
    const result = await ask(matcher)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/every one of its name resolvers failed/)
    expect(result.error).toMatch(/not with the publication/)
  })

  it('refuses a post with no author name, and never asks a resolver', async () => {
    const { matcher, resolve } = realMatcher(undefined, signer().address)
    expect(await ask(matcher)).toEqual({ success: false, error: DEFAULT_MESSAGE, reason: DEFAULT_MESSAGE })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses a name that is not an ID, even one that resolves to the signer, and never asks a resolver', async () => {
    for (const name of ['alice.eth', 'bob.alice.v1.orivonid.eth', 'alice.orv', 'alice.v1.orivonid.com']) {
      const key = signer()
      const { matcher, resolve } = realMatcher(name, key.address, key)
      expect(await ask(matcher), name).toEqual({ success: false, error: DEFAULT_MESSAGE, reason: DEFAULT_MESSAGE })
      expect(resolve, name).not.toHaveBeenCalled()
    }
  })

  it('reads the name an older client sends as the author\'s address', async () => {
    const key = signer()
    const community = { _clientsManager: { resolveAuthorNameIfNeeded: vi.fn(async () => ({ resolvedAuthorName: key.address })) }, _pkc: { _timeouts: { 'resolve-author-name': 1000 } } }
    const matcher = createAuthorIdentityMatcher({ community, publication: { signature: { publicKey: key.publicKey }, author: { address: 'alice.v1.orivonid.eth' } } })
    expect(await ask(matcher)).toEqual({ success: true })
  })
})

describe('a matcher that misbehaves', () => {
  it('refuses when the server supplied no matcher, so a board never lets everyone in by a missing argument', async () => {
    expect(await ask(undefined)).toEqual({ success: false, error: DEFAULT_MESSAGE, reason: DEFAULT_MESSAGE })
  })

  it('refuses when the matcher throws, with the board\'s message', async () => {
    const matcher = { wireName: 'alice.v1.orivonid.eth', matchesIdentity: vi.fn(async () => { throw new Error('boom') }) }
    expect(await ask(matcher)).toEqual({ success: false, error: DEFAULT_MESSAGE, reason: DEFAULT_MESSAGE })
  })

  it('asks the matcher for the author\'s own name and for no other', async () => {
    const matcher = { wireName: 'Alice.v1.orivonid.eth', matchesIdentity: vi.fn(async () => ({ matched: true })), matchesAnyIdentity: vi.fn() }
    expect(await ask(matcher)).toEqual({ success: true })
    expect(matcher.matchesIdentity.mock.calls).toEqual([['Alice.v1.orivonid.eth']])
    expect(matcher.matchesAnyIdentity).not.toHaveBeenCalled()
  })
})

describe('the board owner\'s say', () => {
  it('shows the owner\'s message in place of the default, whole', async () => {
    const result = await ask(realMatcher(undefined, null).matcher, { error: 'Only people with an ID may post here: https://id.orivonstack.eth' })
    expect(result).toEqual({ success: false, error: 'Only people with an ID may post here: https://id.orivonstack.eth', reason: 'Only people with an ID may post here: https://id.orivonstack.eth' })
  })

  it('falls back to the default for an empty message', async () => {
    expect((await ask(realMatcher(undefined, null).matcher, { error: '' })).error).toBe(DEFAULT_MESSAGE)
  })

  it('refuses at edit time a message that is not a short line of text, and takes none', () => {
    const settings = (options: Record<string, unknown> | undefined) => ({ challengeSettings: { name: NAME, ...(options === undefined ? {} : { options }) } })
    const { validateChallengeSettings } = idChallenge({ challengeSettings: {} })
    expect(() => { validateChallengeSettings(settings(undefined)) }).not.toThrow()
    expect(() => { validateChallengeSettings(settings({})) }).not.toThrow()
    expect(() => { validateChallengeSettings(settings({ error: 'A short line.' })) }).not.toThrow()
    expect(() => { validateChallengeSettings(settings({ error: 'x'.repeat(501) })) }).toThrow(/500 characters/)
    expect(() => { validateChallengeSettings(settings({ error: 'two\nlines' })) }).toThrow(/one line/)
  })
})

describe('what the challenge says of itself', () => {
  it('is a factory pkc-js accepts, with the one option the board owner may set, and a text type', async () => {
    const { validateChallengeFileFactory } = await import('@pkcprotocol/pkc-js/challenges')
    expect(() => { validateChallengeFileFactory(idChallenge, { name: NAME }) }).not.toThrow()
    const made = idChallenge({ challengeSettings: {} })
    expect(made.type).toBe('text/plain')
    expect(made.description).toMatch(/Orivon ID/)
    expect(made.optionInputs.map((input: { option: string }) => input.option)).toEqual(['error'])
    expect(made.optionInputs[0]).toMatchObject({ option: 'error', default: DEFAULT_MESSAGE })
    expect(made.optionInputs[0]!.required).toBeUndefined()
    expect(typeof made.getChallenge).toBe('function')
  })

  it('is named by the package name a board\'s settings use, in a scope that is ours', () => {
    expect(NAME).toBe('@orivon/id-challenge')
    expect(PARENT).toBe('v1.orivonid.eth')
  })
})

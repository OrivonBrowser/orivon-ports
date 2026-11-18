// The excludes of a board's challenge as pkc-js 0.0.132 spells them (`roles`, `publicKeys`, `names` and the rest), what each says in a
// person's words, and the texts a form edits them as. What the form writes is parsed by pkc-js's own schema, read from the installed package.
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COMMUNITY } from '../../page/dashboard/terms.js'
import { emptyTexts, excludeOf, legacyOf, textsOf, wordsOfExclude } from '../../page/dashboard/challenge-excludes.js'

const SCHEMA = new URL('../node_modules/@pkcprotocol/pkc-js/dist/node/community/schema.js', import.meta.url)
const schema = await import(pathToFileURL(SCHEMA.pathname).href) as { ChallengeExcludeSettingSchema: { safeParse: (value: unknown) => { success: boolean, error?: { message: string } } } }
const accepted = (value: unknown) => schema.ChallengeExcludeSettingSchema.safeParse(value).success

const KEY = '12D3KooWAuthorKeyOne'
const KEYS = (index: number) => `b${String(index)}`
const indexOf = (key: string) => Number(key.slice(1))
const BOARD = { board: 'board', boards: 'boards', Board: 'Board', Boards: 'Boards' }

describe('what pkc-js itself accepts, which the tests below are held against', () => {
  it('refuses the fields the challenge composer writes (role, address) and takes the ones 0.0.132 names', () => {
    expect(accepted({ role: ['moderator'] })).toBe(false)
    expect(accepted({ address: [KEY] })).toBe(false)
    expect(accepted({ roles: ['moderator'] })).toBe(true)
    expect(accepted({ publicKeys: [KEY] })).toBe(true)
    expect(accepted({ names: ['alice.eth'] })).toBe(true)
    expect(accepted({ publicKeys: ['alice.eth'] })).toBe(false)
    expect(accepted({ names: [KEY] })).toBe(false)
  })
})

describe('the texts of a rule that sets nothing', () => {
  it('are empty, and a rule of them is refused with a message instead of being written as a rule that matches nobody', () => {
    const made = excludeOf(emptyTexts(), undefined, indexOf)
    expect(made.exclude).toBeUndefined()
    expect(made.errors['rule']).toMatch(/at least one condition/i)
  })
})

describe('every condition, as the form writes it', () => {
  const cases: Array<[string, Partial<ReturnType<typeof emptyTexts>>, Record<string, unknown>]> = [
    ['roles', { roles: ['admin', 'moderator'] }, { roles: ['admin', 'moderator'] }],
    ['public keys', { publicKeys: `${KEY}, 12D3KooWAuthorKeyTwo\n12D3KooWAuthorKeyThree` }, { publicKeys: [KEY, '12D3KooWAuthorKeyTwo', '12D3KooWAuthorKeyThree'] }],
    ['names', { names: 'alice.eth  bob.bso' }, { names: ['alice.eth', 'bob.bso'] }],
    ['scores and counts', { postScore: '5', replyScore: '-2', postCount: '3', replyCount: '0' }, { postScore: 5, replyScore: -2, postCount: 3, replyCount: 0 }],
    ['account age', { ageValue: '2', ageUnit: 'days' }, { firstCommentTimestamp: 172_800 }],
    ['publication types', { types: ['post', 'vote'] }, { publicationType: { post: true, vote: true } }],
    ['a rate limit that counts the passes', { rateLimit: '5', rateCounts: 'passed' }, { rateLimit: 5 }],
    ['a rate limit that counts the failures', { rateLimit: '5', rateCounts: 'failed' }, { rateLimit: 5, rateLimitChallengeSuccess: false }],
    ['challenges passed', { after: ['b0', 'b2'] }, { challenges: [0, 2] }],
    ['reputation in other boards', { communityAddresses: 'one.eth 12D3KooWOther', communityMax: '5', communityPostScore: '10', communityReplyScore: '1', communityAgeValue: '1', communityAgeUnit: 'hours' }, { community: { addresses: ['one.eth', '12D3KooWOther'], maxCommentCids: 5, postScore: 10, replyScore: 1, firstCommentTimestamp: 3_600 } }]
  ]

  it.each(cases)('%s are written as the schema names them, and the schema accepts what is written', (_name, texts, expected) => {
    const made = excludeOf({ ...emptyTexts(), ...texts }, undefined, indexOf)
    expect(made.errors).toEqual({})
    expect(made.exclude).toEqual(expected)
    expect(accepted(made.exclude)).toBe(true)
  })

  it('all together are one rule, each key once, and the schema accepts the whole', () => {
    const texts = { ...emptyTexts(), roles: ['owner'], publicKeys: KEY, names: 'a.eth', postScore: '1', replyScore: '1', postCount: '1', replyCount: '1', ageValue: '1', ageUnit: 'hours', types: ['reply'], rateLimit: '2', rateCounts: 'passed' as const, after: ['b1'], communityAddresses: 'x.eth' }
    const made = excludeOf(texts, undefined, indexOf)
    expect(made.errors).toEqual({})
    expect(Object.keys(made.exclude as object).sort()).toEqual(['challenges', 'community', 'firstCommentTimestamp', 'names', 'postCount', 'postScore', 'publicKeys', 'publicationType', 'rateLimit', 'replyCount', 'replyScore', 'roles'])
    expect(accepted(made.exclude)).toBe(true)
  })

  it('never writes role or address, whatever the rule held before', () => {
    const made = excludeOf({ ...emptyTexts(), roles: ['moderator'] }, { role: ['moderator'], address: [KEY] }, indexOf)
    expect(made.exclude).toEqual({ roles: ['moderator'] })
  })
})

describe('what is not accepted', () => {
  it.each([
    ['publicKeys', { publicKeys: 'alice.eth' }, /key/i],
    ['names', { names: KEY }, /name/i],
    ['postCount', { postCount: '-1' }, /whole number/i],
    ['postScore', { postScore: '1.5' }, /whole number/i],
    ['rateLimit', { rateLimit: 'many' }, /whole number/i],
    ['ageValue', { ageValue: '0', ageUnit: 'days' }, /above 0/i],
    ['communityMax', { communityAddresses: 'x.eth', communityMax: 'x' }, /whole number/i],
    ['communityAddresses', { communityPostScore: '1' }, /address/i]
  ])('%s: a message next to the field, and nothing written', (field, texts, message) => {
    const made = excludeOf({ ...emptyTexts(), ...texts }, undefined, indexOf)
    expect(made.exclude).toBeUndefined()
    expect(made.errors[field]).toMatch(message)
  })

  it('a challenge that is no longer in the list is dropped from a rule, and a rule left with nothing else is reported as dropped', () => {
    const only = excludeOf({ ...emptyTexts(), after: ['b9'] }, undefined, (key) => (key === 'b9' ? -1 : indexOf(key)))
    expect(only.exclude).toBeUndefined()
    expect(only.dropped).toBe(true)
    const more = excludeOf({ ...emptyTexts(), roles: ['admin'], after: ['b9', 'b0'] }, undefined, (key) => (key === 'b9' ? -1 : indexOf(key)))
    expect(more.exclude).toEqual({ roles: ['admin'], challenges: [0] })
    expect(more.dropped).toBeUndefined()
  })
})

describe('reading a rule into texts and writing it back', () => {
  const rules: Array<Record<string, unknown>> = [
    { roles: ['owner', 'admin', 'moderator'] },
    { publicKeys: [KEY], names: ['alice.eth'], postScore: 3, replyCount: 2, firstCommentTimestamp: 90_000, publicationType: { post: true, reply: true }, rateLimit: 4, rateLimitChallengeSuccess: false, challenges: [1] },
    { community: { addresses: ['x.eth'], maxCommentCids: 3 } },
    { roles: ['moderator'], futureField: { kept: true } }
  ]

  it.each(rules.map((rule) => [JSON.stringify(rule), rule] as const))('%s comes back as it was, an unknown field of a newer pkc-js too', (_label, rule) => {
    const made = excludeOf(textsOf(rule, KEYS), rule, indexOf)
    expect(made.errors).toEqual({})
    expect(made.exclude).toEqual(rule)
  })

  it('takes the age in the largest unit that holds it exactly', () => {
    expect(textsOf({ firstCommentTimestamp: 172_800 }, KEYS)).toMatchObject({ ageValue: '2', ageUnit: 'days' })
    expect(textsOf({ firstCommentTimestamp: 5_400 }, KEYS)).toMatchObject({ ageValue: '90', ageUnit: 'minutes' })
  })

  it('reads the fields of before 0.0.132 as the ones it names now, and says it did', () => {
    const old = { role: ['moderator'], address: [KEY, 'alice.eth'] }
    expect(legacyOf(old)).toBe(true)
    expect(legacyOf({ roles: ['moderator'] })).toBe(false)
    const texts = textsOf(old, KEYS)
    expect(texts.roles).toEqual(['moderator'])
    expect(texts.publicKeys).toBe(KEY)
    expect(texts.names).toBe('alice.eth')
    const made = excludeOf(texts, old, indexOf)
    expect(made.exclude).toEqual({ roles: ['moderator'], publicKeys: [KEY], names: ['alice.eth'] })
    expect(accepted(made.exclude)).toBe(true)
  })
})

describe('what a rule says', () => {
  const ctx = { term: BOARD, nameOfChallenge: (index: number) => ['captcha-canvas', 'wordfilter', 'voucher'][index] ?? `challenge ${String(index + 1)}` }

  it('names the people it lets through', () => {
    expect(wordsOfExclude({ roles: ['moderator', 'admin'] }, ctx)).toBe('a moderator or an admin')
    expect(wordsOfExclude({ roles: ['owner'] }, ctx)).toBe('the owner')
    expect(wordsOfExclude({ publicKeys: [KEY] }, ctx)).toBe(`the author with the key ${KEY}`)
    expect(wordsOfExclude({ publicKeys: [KEY, 'K2'] }, ctx)).toBe(`an author with one of these keys: ${KEY}, K2`)
    expect(wordsOfExclude({ names: ['alice.eth'] }, ctx)).toBe('the author named alice.eth')
  })

  it('says each number as an at-least, and an age as how old the account is', () => {
    expect(wordsOfExclude({ postScore: 5 }, ctx)).toBe('an author with a post score of at least 5')
    expect(wordsOfExclude({ postCount: 1, replyCount: 10 }, ctx)).toBe('an author with at least 1 post and at least 10 replies')
    expect(wordsOfExclude({ firstCommentTimestamp: 172_800 }, ctx)).toBe('an author whose first comment is at least 2 days old')
  })

  it('says what kind of publication, a rate, the challenges passed and the reputation in other boards', () => {
    expect(wordsOfExclude({ publicationType: { vote: true, post: true } }, ctx)).toBe('when the publication is a post or a vote')
    expect(wordsOfExclude({ publicationType: { communityEdit: true } }, { ...ctx, term: COMMUNITY })).toBe('when the publication is a change to the community')
    expect(wordsOfExclude({ rateLimit: 3 }, ctx)).toBe('up to 3 publications an hour (counting the ones that passed their challenges)')
    expect(wordsOfExclude({ rateLimit: 3, rateLimitChallengeSuccess: false, publicationType: { reply: true } }, ctx)).toBe('when the publication is a reply, up to 3 publications an hour (counting the ones that failed their challenges)')
    expect(wordsOfExclude({ challenges: [1, 2] }, ctx)).toBe('an author who passed the challenges wordfilter and voucher')
    expect(wordsOfExclude({ community: { addresses: ['x.eth'], maxCommentCids: 3, postScore: 4 } }, ctx)).toBe('an author with a post score of at least 4 in x.eth, shown by up to 3 of their comments there')
  })

  it('joins what one rule asks with "and", and says plainly what it cannot read', () => {
    expect(wordsOfExclude({ roles: ['moderator'], postScore: 5 }, ctx)).toBe('a moderator, and an author with a post score of at least 5')
    expect(wordsOfExclude({}, ctx)).toBe('nobody (this rule sets no condition)')
    expect(wordsOfExclude({ roles: ['moderator'], futureField: true }, ctx)).toBe('a moderator, and other conditions this page does not show (futureField)')
  })
})

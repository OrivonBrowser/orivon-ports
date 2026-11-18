// What a board must publish to be listed in a directory, checked against the board's own record: boards that pass and fail each
// requirement, the rules that must come first and in order, and the words a board owner reads for what is missing.
import { describe, expect, it } from 'vitest'
import { eligibilityOf, fixOf, requirementsOf, unmetOf, wordsOf } from '../../page/dashboard/listing-requirements.js'

const MOD_QUEUE = [{ type: 'mod-queue', pendingApproval: true }]
const DIRECTORY = {
  features: { pseudonymityMode: 'per-reply', safeForWork: true, requirePostLinkIsMedia: true, postsPerPage: 15, noUpvotes: true },
  rules: ['Stay on topic.', 'No bots or AI posters.']
}
const PASSING = { features: { pseudonymityMode: 'per-reply', safeForWork: true, requirePostLinkIsMedia: true }, challenges: MOD_QUEUE, rules: DIRECTORY.rules }
const types = (list: Array<{ type: string }>) => list.map((one) => one.type)

describe('the requirements of a directory', () => {
  it('come from the settings it checks, and always include no galleries and a mod queue', () => {
    expect(requirementsOf({ features: DIRECTORY.features })).toEqual([
      { type: 'pseudonymityMode', mode: 'per-reply' }, { type: 'safeForWork', safeForWork: true }, { type: 'requirePostLinkIsMedia' }, { type: 'noGallery' }, { type: 'pendingApproval' }
    ])
    expect(requirementsOf({})).toEqual([{ type: 'noGallery' }, { type: 'pendingApproval' }])
    expect(requirementsOf(undefined)).toEqual([{ type: 'noGallery' }, { type: 'pendingApproval' }])
    expect(requirementsOf({ features: { requirePostLinkIsMedia: false } })).toEqual([{ type: 'noGallery' }, { type: 'pendingApproval' }])
  })

  it('name the directory rules only when it has some, and keep the ones that are text', () => {
    expect(requirementsOf({ rules: ['One.', '', 7, 'Two.'] as never }).at(-1)).toEqual({ type: 'rules', rules: ['One.', 'Two.'] })
    expect(types(requirementsOf({ rules: [] }))).toEqual(['noGallery', 'pendingApproval'])
    expect(types(requirementsOf({ rules: 'One.' as never }))).toEqual(['noGallery', 'pendingApproval'])
  })
})

describe('a board against the requirements', () => {
  const requirements = requirementsOf(DIRECTORY)

  it('passes when its record publishes every one of them', () => {
    expect(unmetOf(requirements, PASSING)).toEqual([])
    expect(eligibilityOf(requirements, PASSING)).toBe('eligible')
  })

  it('is unknown until its record has been published', () => {
    expect(eligibilityOf(requirements, undefined)).toBe('unknown')
    expect(eligibilityOf(requirements, null)).toBe('unknown')
  })

  it('fails the poster-ID requirement for another mode or none', () => {
    expect(types(unmetOf(requirements, { ...PASSING, features: { ...PASSING.features, pseudonymityMode: 'per-post' } }))).toEqual(['pseudonymityMode'])
    expect(types(unmetOf(requirements, { ...PASSING, features: { safeForWork: true, requirePostLinkIsMedia: true } }))).toEqual(['pseudonymityMode'])
  })

  it('wants a board marked safe for work to say so, and an NSFW directory only to not say it', () => {
    expect(types(unmetOf(requirements, { ...PASSING, features: { ...PASSING.features, safeForWork: false } }))).toEqual(['safeForWork'])
    expect(types(unmetOf(requirements, { ...PASSING, features: { pseudonymityMode: 'per-reply', requirePostLinkIsMedia: true } }))).toEqual(['safeForWork'])
    const nsfw = requirementsOf({ features: { safeForWork: false } })
    expect(unmetOf(nsfw, { challenges: MOD_QUEUE, features: {} })).toEqual([])
    expect(unmetOf(nsfw, { challenges: MOD_QUEUE, features: { safeForWork: false } })).toEqual([])
    expect(types(unmetOf(nsfw, { challenges: MOD_QUEUE, features: { safeForWork: true } }))).toEqual(['safeForWork'])
  })

  it('fails when thread links need not be media files', () => {
    expect(types(unmetOf(requirements, { ...PASSING, features: { ...PASSING.features, requirePostLinkIsMedia: false } }))).toEqual(['requirePostLinkIsMedia'])
  })

  it('fails when posts or replies take galleries, and passes when both limits are unset or 0', () => {
    const base = requirementsOf({})
    expect(unmetOf(base, { challenges: MOD_QUEUE })).toEqual([])
    expect(unmetOf(base, { challenges: MOD_QUEUE, features: { maxPostGalleryItems: 0, maxReplyGalleryItems: 0 } })).toEqual([])
    expect(types(unmetOf(base, { challenges: MOD_QUEUE, features: { maxPostGalleryItems: 4 } }))).toEqual(['noGallery'])
    expect(types(unmetOf(base, { challenges: MOD_QUEUE, features: { maxPostGalleryItems: 0, maxReplyGalleryItems: 1 } }))).toEqual(['noGallery'])
  })

  it('fails with no challenge that holds a new poster for approval', () => {
    const base = requirementsOf({})
    expect(types(unmetOf(base, { features: {} }))).toEqual(['pendingApproval'])
    expect(types(unmetOf(base, { challenges: [] }))).toEqual(['pendingApproval'])
    expect(types(unmetOf(base, { challenges: [{ type: 'text-math' }, { pendingApproval: false }] }))).toEqual(['pendingApproval'])
    expect(unmetOf(base, { challenges: [{ type: 'text-math' }, { pendingApproval: true }] })).toEqual([])
  })

  it('wants the directory rules first, word for word, and lets the board add its own after them', () => {
    const rules = requirementsOf({ rules: DIRECTORY.rules })
    expect(unmetOf(rules, { challenges: MOD_QUEUE, rules: [...DIRECTORY.rules, 'No reaction images.'] })).toEqual([])
    expect(unmetOf(rules, { challenges: MOD_QUEUE, rules: ['Stay on topic. ', '\nNo bots or AI posters.'] })).toEqual([])
    const unmet = [{ type: 'rules', rules: DIRECTORY.rules }]
    expect(unmetOf(rules, { challenges: MOD_QUEUE })).toEqual(unmet)
    expect(unmetOf(rules, { challenges: MOD_QUEUE, rules: ['Stay on topic.'] })).toEqual(unmet)
    expect(unmetOf(rules, { challenges: MOD_QUEUE, rules: ['Stay on topic.', 'No bots.'] })).toEqual(unmet)
    expect(unmetOf(rules, { challenges: MOD_QUEUE, rules: [...DIRECTORY.rules].reverse() })).toEqual(unmet)
    expect(unmetOf(rules, { challenges: MOD_QUEUE, rules: ['No reaction images.', ...DIRECTORY.rules] })).toEqual(unmet)
    expect(unmetOf(rules, { challenges: MOD_QUEUE, rules: 'Stay on topic.' as never })).toEqual(unmet)
  })

  it('is ineligible with every requirement it misses named, in the order the directory lists them', () => {
    expect(eligibilityOf(requirements, { features: {} })).toBe('ineligible')
    expect(types(unmetOf(requirements, { features: {} }))).toEqual(['pseudonymityMode', 'safeForWork', 'requirePostLinkIsMedia', 'pendingApproval', 'rules'])
  })
})

describe('the words a board owner reads', () => {
  it('say what is missing in plain words, with no setting name in them', () => {
    const all = requirementsOf({ features: { pseudonymityMode: 'per-post', safeForWork: true, requirePostLinkIsMedia: true }, rules: ['A.'] })
    const words = all.map(wordsOf)
    expect(words).toEqual([
      'Poster IDs that last for one thread',
      'The board is marked safe for work',
      'A thread must link to a picture or a video',
      'Every post is a single file, never a gallery',
      'A new poster waits for a moderator to approve the first posts',
      "The directory's rules come first in the board's rules, word for word"
    ])
    for (const one of words) expect(one).not.toMatch(/features\.|pendingApproval|pseudonymityMode/)
  })

  it('say the NSFW case, a poster-ID mode with no plain name, and a gallery or a mod queue', () => {
    expect(wordsOf({ type: 'safeForWork', safeForWork: false })).toBe('The board is not marked safe for work')
    expect(wordsOf({ type: 'pseudonymityMode', mode: 'per-reply' })).toBe('No poster IDs: every reply comes from a new address')
    expect(wordsOf({ type: 'pseudonymityMode', mode: 'per-author' })).toBe('Poster IDs that stay the same for each author')
    expect(wordsOf({ type: 'pseudonymityMode', mode: 'something-new' })).toBe('Poster IDs set to "something-new"')
  })

  it('name the setting to change, as the board record spells it', () => {
    expect(fixOf({ type: 'pseudonymityMode', mode: 'per-reply' })).toBe('features.pseudonymityMode: per-reply')
    expect(fixOf({ type: 'safeForWork', safeForWork: true })).toBe('features.safeForWork: true')
    expect(fixOf({ type: 'safeForWork', safeForWork: false })).toBe('features.safeForWork: false')
    expect(fixOf({ type: 'requirePostLinkIsMedia' })).toBe('features.requirePostLinkIsMedia: true')
    expect(fixOf({ type: 'noGallery' })).toBe('features.maxPostGalleryItems, features.maxReplyGalleryItems: 0')
    expect(fixOf({ type: 'pendingApproval' })).toBe('one challenge with pendingApproval: true')
    expect(fixOf({ type: 'rules', rules: ['A.'] })).toBe('rules[0]')
    expect(fixOf({ type: 'rules', rules: ['A.', 'B.', 'C.'] })).toBe('rules[0..2]')
  })
})

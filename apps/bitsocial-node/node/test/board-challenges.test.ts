// What the Worker does for a page that edits a board's challenges: lists the boards it hosts, reads a board's challenges, and applies a new
// list by reading the board's settings, replacing `challenges` alone and writing the whole back (an edit replaces `settings` whole).
import { describe, expect, it } from 'vitest'
import { boardChallenges, ConflictError, NotHostedError, SettingsError } from '../worker/board-challenges.js'

const A = '12D3KooWBoardA'
const B = 'second.bso'
const WORD = { name: '@bitsocial/wordfilter-challenge', options: { 'wordfilter/v1/rules': '[{"src":"a","dst":"b"}]' }, publicOptions: ['wordfilter/v1/rules'] }
const B64 = { name: '@bitsocial/base64-challenge' }
const PAGES = { posts: [{ name: 'active' }], replies: [] }

/** Boards in memory, answering as pkc-js does: an edit replaces `settings` whole. */
function setup (settings: Record<string, Record<string, unknown> | undefined> = { [A]: { challenges: [WORD], pages: PAGES, fetchThumbnailUrls: true, maxPendingApprovalCount: 5 }, [B]: {} }) {
  const calls: Array<[string, Record<string, unknown>]> = []
  const failWith: { error: unknown } = { error: null }
  const api = boardChallenges({
    hosted: () => [{ address: B, name: B, publicKey: '12D3KooWKeyB', started: false, secret: 'never listed' }, { address: A, publicKey: A, started: true }],
    read: async (address: string) => structuredClone(settings[address] ?? {}),
    edit: async (address: string, next: Record<string, unknown>) => {
      calls.push([address, structuredClone(next)])
      if (failWith.error !== null) throw failWith.error
      settings[address] = structuredClone(next)
      return structuredClone(next)
    }
  })
  return { api, settings, calls, failWith }
}

describe('the boards', () => {
  it('lists each board the node hosts with its address, its name and whether it runs, and nothing the node keeps private', async () => {
    const { api } = setup()
    expect(api.boards()).toEqual({ boards: [{ address: A, publicKey: A, started: true }, { address: B, name: B, publicKey: '12D3KooWKeyB', started: false }] })
  })
})

describe('a board\'s challenges', () => {
  it('are the entries of its settings, with the names of the settings the board has besides them', async () => {
    const { api } = setup()
    expect(await api.board(A)).toEqual({ address: A, challenges: [WORD], otherSettings: ['fetchThumbnailUrls', 'maxPendingApprovalCount', 'pages'] })
  })

  it('are none, and no other setting, for a board that has set nothing', async () => {
    const { api } = setup()
    expect(await api.board(B)).toEqual({ address: B, challenges: [], otherSettings: [] })
  })

  it('are refused for a board this node does not host, which is not read at all', async () => {
    const { api, calls } = setup()
    await expect(api.board('someone-elses.bso')).rejects.toBeInstanceOf(NotHostedError)
    await expect(api.apply('someone-elses.bso', [B64])).rejects.toBeInstanceOf(NotHostedError)
    expect(calls).toEqual([])
  })
})

describe('applying a list', () => {
  it('reads the settings, replaces challenges and writes the whole back, so every other setting is as it was', async () => {
    const { api, calls, settings } = setup()
    const answer = await api.apply(A, [B64, WORD])
    expect(calls).toEqual([[A, { challenges: [B64, WORD], pages: PAGES, fetchThumbnailUrls: true, maxPendingApprovalCount: 5 }]])
    expect(settings[A]).toEqual({ challenges: [B64, WORD], pages: PAGES, fetchThumbnailUrls: true, maxPendingApprovalCount: 5 })
    expect(answer).toEqual({ address: A, challenges: [B64, WORD], otherSettings: ['fetchThumbnailUrls', 'maxPendingApprovalCount', 'pages'] })
  })

  it('writes the order it was given, and an empty list when every challenge is removed', async () => {
    const { api, settings } = setup()
    await api.apply(A, [B64, WORD, B64])
    expect((settings[A]!['challenges'] as Array<{ name: string }>).map((one) => one.name)).toEqual([B64.name, WORD.name, B64.name])
    await api.apply(A, [])
    expect(settings[A]!['challenges']).toEqual([])
    expect(settings[A]!['pages']).toEqual(PAGES)
  })

  it('writes to a board that had no settings at all, and to nothing but the board it was asked for', async () => {
    const { api, settings, calls } = setup()
    await api.apply(B, [B64])
    expect(calls.map(([address]) => address)).toEqual([B])
    expect(settings[B]).toEqual({ challenges: [B64] })
    expect(settings[A]!['challenges']).toEqual([WORD])
  })

  it('does not write when the list is the one the board has', async () => {
    const { api, calls } = setup()
    const answer = await api.apply(A, [{ ...WORD }])
    expect(calls).toEqual([])
    expect(answer.challenges).toEqual([WORD])
  })

  it('refuses a list the board no longer has as the page read it, and writes nothing', async () => {
    const { api, calls, settings } = setup()
    settings[A]!['challenges'] = [WORD, B64]
    await expect(api.apply(A, [B64], [WORD])).rejects.toBeInstanceOf(ConflictError)
    expect(calls).toEqual([])
    await api.apply(A, [B64], [WORD, B64])
    expect(calls).toHaveLength(1)
  })

  it('takes what the page read as the same whatever order its keys were written in', async () => {
    const { api, calls } = setup()
    await api.apply(A, [B64], [{ publicOptions: ['wordfilter/v1/rules'], options: { 'wordfilter/v1/rules': '[{"src":"a","dst":"b"}]' }, name: WORD.name }])
    expect(calls).toHaveLength(1)
  })
})

describe('a list that is not a list of challenges', () => {
  it.each([
    ['not an array', 'x'],
    ['an entry that is not an object', ['x']],
    ['an entry with no name and no path', [{ options: {} }]],
    ['an entry whose name is not text', [{ name: 7 }]],
    ['an array inside the array', [[B64]]],
    ['more than a hundred entries', Array.from({ length: 101 }, () => B64)]
  ])('%s is refused before the board is read', async (_label, value) => {
    const { api, calls } = setup()
    await expect(api.apply(A, value as never)).rejects.toBeInstanceOf(SettingsError)
    expect(calls).toEqual([])
  })

  it('is not changed by being read: the page\'s own list is untouched', async () => {
    const { api } = setup()
    const given = [B64]
    await api.apply(A, given)
    expect(given).toEqual([B64])
  })
})

describe('a write pkc-js refuses', () => {
  const failure = (index: number, name: string, code: string, message: string, details: Record<string, unknown>) => ({ challengeIndex: index, challengeName: name, error: Object.assign(new Error(message), { code, details }) })

  it('says which challenge and which option, from every failure it lists, and the board stays as it was', async () => {
    const { api, failWith, settings } = setup()
    failWith.error = Object.assign(new Error('One or more challenges in settings.challenges failed validation'), {
      code: 'ERR_CHALLENGE_SETTINGS_VALIDATION_FAILED_FOR_CHALLENGES',
      details: {
        failures: [
          failure(0, '@bitsocial/evm-contract-challenge', 'ERR_CHALLENGE_REQUIRED_OPTION_MISSING', 'settings.challenges[i].options is missing an option whose optionInputs entry is required', { missingOption: 'address' }),
          failure(1, '@bitsocial/wordfilter-challenge', 'ERR_CHALLENGE_SETTINGS_VALIDATION_FAILED', 'The challenge\'s validateChallengeSettings hook rejected settings.challenges[i]', { validationError: 'wordfilter/v1/rules must be listed in publicOptions' })
        ]
      }
    })
    const error = await api.apply(A, [WORD, B64]).catch((one: unknown) => one) as SettingsError
    expect(error).toBeInstanceOf(SettingsError)
    expect(error.failures).toEqual([
      { index: 0, name: '@bitsocial/evm-contract-challenge', option: 'address', message: 'a required option is missing: address' },
      { index: 1, name: '@bitsocial/wordfilter-challenge', option: null, message: 'wordfilter/v1/rules must be listed in publicOptions' }
    ])
    expect(error.message).toBe('Challenge 1 (evm-contract): a required option is missing: address. Challenge 2 (wordfilter): wordfilter/v1/rules must be listed in publicOptions.')
    expect(settings[A]!['challenges']).toEqual([WORD])
  })

  it('names an option the challenge does not declare', async () => {
    const { api, failWith } = setup()
    failWith.error = Object.assign(new Error('x'), { code: 'ERR_CHALLENGE_SETTINGS_VALIDATION_FAILED_FOR_CHALLENGES', details: { failures: [failure(0, '@bitsocial/base64-challenge', 'ERR_CHALLENGE_OPTION_NOT_DECLARED_IN_OPTION_INPUTS', 'x', { offendingOption: 'typo' })] } })
    const error = await api.apply(A, [B64]).catch((one: unknown) => one) as SettingsError
    expect(error.failures[0]).toMatchObject({ option: 'typo', message: 'the option typo is not one this challenge has' })
  })

  it('gives the message of any other pkc-js error, as a refusal of the settings, and lets an error that is not pkc-js\'s go as it is', async () => {
    const { api, failWith } = setup()
    failWith.error = Object.assign(new Error('User sent a community edit options with invalid schema'), { code: 'ERR_COMMUNITY_EDIT_OPTIONS_SCHEMA', details: {} })
    const error = await api.apply(A, [B64]).catch((one: unknown) => one) as SettingsError
    expect(error).toBeInstanceOf(SettingsError)
    expect(error.failures).toEqual([])
    expect(error.message).toBe('User sent a community edit options with invalid schema')
    failWith.error = new TypeError('the node is gone')
    await expect(api.apply(A, [B64])).rejects.toBeInstanceOf(TypeError)
  })
})

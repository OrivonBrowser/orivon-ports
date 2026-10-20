import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkPin, checkScore } from '../site/checks.js'
import { createContext } from '../site/fetchers.js'
import { SCORE_PROVIDER, SITES } from '../site/targets.js'
import { bucketOf } from '../site/score.js'

const SHA = 'a'.repeat(40)
const CID = 'bafybeieqer67ojhi6q3eiatmrcu3r3mqjehn7hwit2satqjfnljo65fb4q'
const site = SITES.find((candidate) => candidate.id === 'asgardex')!

const recipe = JSON.stringify({ id: 'asgardex', upstream: { repo: 'https://github.com/asgardex/asgardex-desktop.git', ref: SHA, licence: 'MIT' } })
const releases = JSON.stringify([
  { tag_name: 'v1.46.1', draft: false, prerelease: false, published_at: '2026-10-09T10:00:00Z', html_url: 'https://github.com/asgardex/asgardex-desktop/releases/tag/v1.46.1' },
  { tag_name: 'v1.47.0-rc.1', draft: false, prerelease: true, published_at: '2026-10-15T10:00:00Z', html_url: 'https://github.com/x' }
])
const commit = JSON.stringify({ sha: SHA, commit: { committer: { date: '2026-09-01T10:00:00Z' } } })

type Route = Response | (() => Response)
function serve (routes: Record<string, Route>): string[] {
  const asked: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    asked.push(url)
    const match = Object.entries(routes).find(([part]) => url.includes(part))
    if (!match) return new Response('', { status: 404 })
    return typeof match[1] === 'function' ? match[1]() : match[1].clone()
  })
  return asked
}
const text = (body: string, status = 200): Response => new Response(body, { status })

afterEach(() => { vi.unstubAllGlobals() })

describe('checkPin', () => {
  it('gives the pinned commit\'s date and the newest stable release from three reads', async () => {
    const asked = serve({
      '/repos/OrivonBrowser/orivon-ports/contents/apps/asgardex/recipe.json?ref=main': text(recipe),
      [`/repos/asgardex/asgardex-desktop/commits/${SHA}`]: text(commit),
      '/repos/asgardex/asgardex-desktop/releases?per_page=30': text(releases)
    })
    const state = await checkPin(createContext(), site)
    expect(state).toMatchObject({ status: 'ok', pinned: '2026-09-01', release: 'v1.46.1, 2026-10-09', days: 38, relation: 'behind' })
    expect(asked).toHaveLength(3)
  })

  it('is skipped for a row that is not somebody else\'s app, without asking anything', async () => {
    const asked = serve({})
    expect(await checkPin(createContext(), SITES.find((candidate) => candidate.id === 'docs')!)).toEqual({ status: 'skipped' })
    expect(asked).toEqual([])
  })

  it('is "limited", not an error of the app, when GitHub rate limits the visitor', async () => {
    serve({ '/contents/apps/asgardex/recipe.json': text('{"message":"API rate limit exceeded"}', 403) })
    expect(await checkPin(createContext(), site)).toMatchObject({ status: 'limited', error: expect.stringContaining('limiting') })
    serve({ '/contents/apps/asgardex/recipe.json': text(recipe), '/commits/': text('{}', 429), '/releases?': text(releases) })
    expect(await checkPin(createContext(), site)).toMatchObject({ status: 'limited' })
  })

  it('still gives the pin when upstream has no release that counts', async () => {
    serve({ '/contents/': text(recipe), '/commits/': text(commit), '/releases?': text('[]') })
    expect(await checkPin(createContext(), site)).toMatchObject({ status: 'ok', pinned: '2026-09-01', release: null, relation: 'unknown' })
  })

  it('is an error that says what could not be read, for a recipe with no pin and for an answer that is not JSON', async () => {
    serve({ '/contents/': text('{"id":"asgardex"}') })
    expect(await checkPin(createContext(), site)).toMatchObject({ status: 'error', error: expect.stringContaining('upstream commit') })
    serve({ '/contents/': text(recipe), '/commits/': text('<html>'), '/releases?': text(releases) })
    expect(await checkPin(createContext(), site)).toMatchObject({ status: 'error', error: expect.stringContaining('cannot read') })
  })
})

describe('checkScore', () => {
  const provider = JSON.stringify({ standard: 'orivon-web3-score/1', name: 'Orivon Attila V0.0.1', bucketHexChars: 2 })
  const entry = { id: `cid:${CID}`, name: 'App', evaluated: '2026-10-18', trustlessity: { level: 3, privacy: false } }
  const bucketFile = JSON.stringify({ standard: 'orivon-web3-score/1', subject: 'website', bucket: 'c6', entries: [entry] })
  const shared = () => ({ provider: null })

  it('reads the provider, files the CID under its bucket, and finds the evaluation', async () => {
    expect(await bucketOf(`cid:${CID}`, 2)).toBe('c6')
    const asked = serve({ '/score/provider.json': text(provider), '/score/website/c6.json': text(bucketFile) })
    const state = await checkScore(createContext(), CID, shared())
    expect(state).toEqual({ status: 'found', level: 3, privacy: false, evaluated: '2026-10-18', provider: 'Orivon Attila V0.0.1' })
    expect(asked.every((url) => url.includes(`/ipns/${SCORE_PROVIDER.key}/score/`))).toBe(true)
  })

  it('asks for the provider once for a whole run of rows', async () => {
    const asked = serve({ '/score/provider.json': text(provider), '/score/website/': text(bucketFile) })
    const memo = shared()
    await checkScore(createContext(), CID, memo)
    await checkScore(createContext(), CID, memo)
    expect(asked.filter((url) => url.endsWith('/provider.json'))).toHaveLength(1)
  })

  it('says there is no evaluation when the provider has no bucket for it, or none for this build', async () => {
    serve({ '/score/provider.json': text(provider) })
    expect(await checkScore(createContext(), CID, shared())).toEqual({ status: 'none', provider: 'Orivon Attila V0.0.1' })
    serve({ '/score/provider.json': text(provider), '/score/website/c6.json': text(JSON.stringify({ subject: 'website', bucket: 'c6', entries: [{ ...entry, id: 'cid:other' }] })) })
    expect(await checkScore(createContext(), CID, shared())).toMatchObject({ status: 'none' })
  })

  it('does not call an unreachable provider "no evaluation"', async () => {
    serve({ '/score/provider.json': text(provider), '/score/website/c6.json': text('', 504) })
    expect(await checkScore(createContext(), CID, shared())).toMatchObject({ status: 'error', provider: 'Orivon Attila V0.0.1' })
    serve({ '/score/provider.json': text('', 504) })
    expect(await checkScore(createContext(), CID, shared())).toMatchObject({ status: 'error', error: expect.stringContaining('could not be read') })
  })
})

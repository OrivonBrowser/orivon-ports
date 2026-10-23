import { describe, expect, it } from 'vitest'
import { approvalFor, approvalProblem } from '../site/approval.js'
import { SITES } from '../site/catalog.js'

const base = { id: 'demo', name: 'Demo', category: 'dev', summary: 'A demo' }
const approved = (url: string | undefined) => (url === undefined ? {} : { approval: { url } })

/** A port ported from demo.example. */
const port = (url: string | undefined, over: Record<string, unknown> = {}) => ({
  ...base, ...approved(url),
  orivon: { kind: 'port', needsOrivon: true, upstream: 'https://demo.example', published: true, ...over }
}) as never

/** A listed site (a `.eth` app, say) with its own web address and no Orivon mark. */
const site = (url: string | undefined, over: Record<string, unknown> = {}) => ({
  ...base, ens: 'demo.eth', web: 'https://demo.example', ...approved(url), ...over
}) as never

const GOOD = [
  'https://github.com/owner/repo/issues/12',
  'https://github.com/owner/repo/issues/12#issuecomment-123456',
  'https://github.com/owner/repo/discussions/7#discussioncomment-99',
  'https://github.com/owner/repo/pull/3',
  'https://x.com/some_one/status/1849999999999999999'
]

const BAD = [
  'http://github.com/owner/repo/issues/12',
  'https://github.com/owner/repo',
  'https://github.com/owner/repo/issues',
  'https://github.com/owner/repo/issues/12?x=1',
  'https://github.com/owner/repo/issues/12#top',
  'https://user:pw@github.com/owner/repo/issues/12',
  'https://github.com.evil.example/owner/repo/issues/12',
  'https://evil.example/owner/repo/issues/12',
  'https://demo.example/',
  'https://notdemo.example/page',
  'https://demo.example.evil.example/page',
  ' https://github.com/owner/repo/issues/12',
  'javascript:alert(1)',
  'not a url',
  '',
  // X: only a post counts, never the home page, a profile or anything around it.
  'https://x.com/',
  'https://x.com/someone',
  'https://x.com/someone/with_replies',
  'https://x.com/someone/status/',
  'https://x.com/someone/status/abc',
  'https://x.com/someone/status/1?s=20',
  'https://x.com/someone/status/1#top',
  'https://x.com.evil.example/someone/status/1',
  'http://x.com/someone/status/1'
]

describe.each([['a port', port], ['a site', site]] as const)('approvalProblem for %s', (_name, make) => {
  it('accepts a GitHub issue, discussion or pull request, one comment of it, and an X post', () => {
    for (const url of GOOD) expect(approvalProblem(make(url)), url).toBeNull()
  })

  it('accepts a page on the project\'s own site or a subdomain of it', () => {
    for (const url of ['https://demo.example/blog/listing', 'https://forum.demo.example/t/listing/12']) {
      expect(approvalProblem(make(url)), url).toBeNull()
    }
  })

  it('has nothing to say about a listing with no approval', () => {
    expect(approvalProblem(make(undefined))).toBeNull()
  })

  it('fails on a bad URL', () => {
    expect(BAD.length).toBeGreaterThanOrEqual(16 + 8)
    for (const url of BAD) expect(approvalProblem(make(url)), JSON.stringify(url)).not.toBeNull()
  })
})

describe('approvalProblem off GitHub and X', () => {
  it('needs the project\'s own address to match against', () => {
    expect(approvalProblem(site('https://demo.example/blog/listing', { web: undefined }))).not.toBeNull()
    expect(approvalProblem(site('https://github.com/owner/repo/issues/12', { web: undefined }))).toBeNull()
  })

  it('takes a port\'s address from upstream, not from web', () => {
    expect(approvalProblem(port('https://other.example/page', { upstream: 'https://demo.example' }))).not.toBeNull()
  })
})

describe('approvalFor', () => {
  it('shows the mark with its link only for a sound approval, on a port and on a site', () => {
    for (const make of [port, site]) {
      expect(approvalFor(make('https://github.com/owner/repo/issues/12'))).toEqual({
        text: 'Listing approved by the Demo developers',
        href: 'https://github.com/owner/repo/issues/12',
        title: 'The Demo developers\' own public reply'
      })
      expect(approvalFor(make('https://x.com/someone/status/1'))?.href).toBe('https://x.com/someone/status/1')
      expect(approvalFor(make(undefined))).toBeNull()
      expect(approvalFor(make('http://github.com/owner/repo/issues/12'))).toBeNull()
      expect(approvalFor(make('https://x.com/someone'))).toBeNull()
    }
  })
})

describe('the catalog\'s approvals', () => {
  it('are all sound', () => {
    for (const row of SITES) expect(approvalProblem(row), row.id).toBeNull()
  })
})

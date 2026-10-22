import { describe, expect, it } from 'vitest'
import { approvalFor, approvalProblem } from '../site/approval.js'
import { SITES } from '../site/catalog.js'

const port = (approvalUrl: string | undefined, over: Record<string, unknown> = {}) => ({
  id: 'demo', name: 'Demo', category: 'dev', summary: 'A demo',
  orivon: { kind: 'port', needsOrivon: true, upstream: 'https://demo.example', published: true, ...(approvalUrl === undefined ? {} : { approval: { url: approvalUrl } }), ...over }
}) as never

describe('approvalProblem', () => {
  it('accepts a GitHub issue, discussion or pull request, and one comment of it', () => {
    for (const url of [
      'https://github.com/owner/repo/issues/12',
      'https://github.com/owner/repo/issues/12#issuecomment-123456',
      'https://github.com/owner/repo/discussions/7#discussioncomment-99',
      'https://github.com/owner/repo/pull/3'
    ]) expect(approvalProblem(port(url)), url).toBeNull()
  })

  it('accepts a page on the project\'s own site or a subdomain of it', () => {
    for (const url of ['https://demo.example/blog/community-port', 'https://forum.demo.example/t/community-port/12']) {
      expect(approvalProblem(port(url)), url).toBeNull()
    }
  })

  it('has nothing to say about a port with no approval', () => {
    expect(approvalProblem(port(undefined))).toBeNull()
  })

  it('fails on a bad URL', () => {
    for (const url of [
      'http://github.com/owner/repo/issues/12',
      'https://github.com/owner/repo',
      'https://github.com/owner/repo/issues',
      'https://github.com/owner/repo/issues/12?x=1',
      'https://github.com/owner/repo/issues/12#top',
      'https://user:pw@github.com/owner/repo/issues/12',
      'https://github.com.evil.example/owner/repo/issues/12',
      'https://evil.example/owner/repo/issues/12',
      'https://x.com/someone/status/1',
      'https://demo.example/',
      'https://notdemo.example/page',
      'https://demo.example.evil.example/page',
      ' https://github.com/owner/repo/issues/12',
      'javascript:alert(1)',
      'not a url',
      ''
    ]) expect(approvalProblem(port(url)), JSON.stringify(url)).not.toBeNull()
  })

  it('fails on an approval for anything but a port', () => {
    expect(approvalProblem(port('https://github.com/owner/repo/issues/12', { kind: 'native' }))).not.toBeNull()
  })
})

describe('approvalFor', () => {
  it('shows the mark with its link only for a sound approval', () => {
    expect(approvalFor(port('https://github.com/owner/repo/issues/12'))).toEqual({
      text: 'Approved by the Demo developers',
      href: 'https://github.com/owner/repo/issues/12',
      title: 'The Demo developers\' own public reply'
    })
    expect(approvalFor(port(undefined))).toBeNull()
    expect(approvalFor(port('http://github.com/owner/repo/issues/12'))).toBeNull()
  })
})

describe('the catalog\'s approvals', () => {
  it('are all sound', () => {
    for (const site of SITES) expect(approvalProblem(site), site.id).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { classifyReleases, releaseCid, releaseOfCid, skippedText } from '../site/releases.js'

// The release workflow's real body for v0.0.8.
const CID = 'bafybeib4liozf4uwoq57zklkldjtfx5e7u65yl2e4prn3evpl6si3qgwr4'
const BODY = `\n\n### On IPFS\n\nThe same files, as one folder: \`ipfs://${CID}\`. Open it in Orivon, or run \`ipfs get ${CID}\`. The Orivon node pins it within about 15 minutes, with the two releases before it.`

const release = (tag: string, body: string | null, assets = 6, draft = false) => ({ tag_name: tag, html_url: `https://github.com/x/y/releases/tag/${tag}`, published_at: '2026-10-17T18:10:52Z', draft, body, assets: new Array(assets).fill({}) })

describe('the CID in a release body', () => {
  it('reads the ipfs:// address in the On IPFS section', () => {
    expect(releaseCid(BODY)).toBe(CID)
  })

  it('is null without the section, without a CID, or for a malformed one', () => {
    expect(releaseCid('Notes only')).toBeNull()
    expect(releaseCid(null)).toBeNull()
    expect(releaseCid('### On IPFS\n\nnothing yet')).toBeNull()
    expect(releaseCid(`ipfs://${CID}`)).toBeNull()
    expect(releaseCid('### On IPFS\n\nipfs://bafybeib4liozf4uwoq57zklkldjtfx5e7u65yl2e4prn3evpl6si3qgwr4aaaaaaaa')).toBeNull()
  })
})

describe('what to do with each release', () => {
  const cidFor = (n: number) => CID.slice(0, -1) + 'abcdefg'[n]!
  const list = [
    release('v0.0.8', BODY),
    release('v0.0.7-draft', BODY, 6, true),
    release('v0.0.6', BODY.replaceAll(CID, cidFor(1))),
    release('pre-releases', '', 0),
    release('v0.0.5', BODY.replaceAll(CID, cidFor(2))),
    release('v0.0.4', BODY.replaceAll(CID, cidFor(3))),
    release('v0.0.3', 'The workflow broke', 6)
  ]

  it('checks the newest three that have a CID, drops drafts, and sorts the rest', () => {
    expect(classifyReleases(list, 3).map(({ tag, plan }) => [tag, plan])).toEqual([
      ['v0.0.8', 'check'], ['v0.0.6', 'check'], ['pre-releases', 'placeholder'], ['v0.0.5', 'check'], ['v0.0.4', 'old'], ['v0.0.3', 'failed']
    ])
  })

  it('says why a release is not checked', () => {
    expect(skippedText('old', 3)).toBe('Not kept (only the newest 3 stay pinned)')
    expect(skippedText('failed', 3)).toMatch(/release workflow failed/)
    expect(skippedText('placeholder', 3)).toMatch(/placeholder/)
  })

  it('finds the release a folder CID belongs to', () => {
    const releases = classifyReleases(list, 3)
    expect(releaseOfCid(releases, CID)).toBe('v0.0.8')
    expect(releaseOfCid(releases, 'bafybeigo6bgfcvr2lxdt74udz27mlpyhw5jngrqrj6vsqphqvvn6e6cgim')).toBeNull()
    expect(releaseOfCid(releases, null)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { compare, formatReport, parsePublished, publishedBase, verifyApp } from './verify.ts'
import type { FetchedText, Rebuilt, VerifyDeps } from './verify.ts'

const COMMIT = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const LEAVES = { '/.well-known/orivon.json': 'sha256:01', '/index.html': 'sha256:02', '/app.js': 'sha256:03' }

const manifest = (extra: Record<string, unknown> = {}): string => JSON.stringify({ id: 'demo', entry: 'index.html', ...extra })
const ddoc = (bundleHash: string, leaves: Record<string, string> = LEAVES): string => JSON.stringify({ bundleHash, leaves })
const rebuilt = (bundleHash: string, leaves: Record<string, string> = LEAVES, extra: Partial<Rebuilt> = {}): Rebuilt => ({ bundleHash, leaves, ...extra })

describe('parsePublished', () => {
  it('reads the bundle hash and leaves from the ddoc file and the building commit from the manifest', () => {
    const published = parsePublished(manifest({ source: { portsCommit: COMMIT } }), ddoc('sha256:root'))
    expect(published).toEqual({ bundleHash: 'sha256:root', leaves: LEAVES, portsCommit: COMMIT })
  })

  it('leaves the commit out when the manifest does not name a well-formed one', () => {
    expect(parsePublished(manifest(), ddoc('sha256:root')).portsCommit).toBeUndefined()
    expect(parsePublished(manifest({ source: { portsCommit: 'abc123' } }), ddoc('sha256:root')).portsCommit).toBeUndefined()
    expect(parsePublished(manifest({ source: 'x' }), ddoc('sha256:root')).portsCommit).toBeUndefined()
  })

  it('names which published file is unusable', () => {
    expect(() => parsePublished('<html>', ddoc('x'))).toThrow(/published manifest is not JSON/)
    expect(() => parsePublished(manifest(), '[]')).toThrow(/ddoc file is not a JSON object/)
    expect(() => parsePublished(manifest(), '{}')).toThrow(/no bundleHash and leaves/)
  })

  it('keeps a CID only when it is shaped like one', () => {
    expect(parsePublished(manifest(), ddoc('x'), 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi').cid).toMatch(/^bafy/)
    expect(parsePublished(manifest(), ddoc('x'), '<script>').cid).toBeUndefined()
  })
})

describe('compare', () => {
  it('matches when the bundle hash is the same', () => {
    const result = compare(parsePublished(manifest(), ddoc('sha256:root')), rebuilt('sha256:root'))
    expect(result.match).toBe(true)
    expect(result.files).toEqual({ changed: [], onlyPublished: [], onlyRebuilt: [] })
  })

  it('names the files that differ, those only published and those only rebuilt', () => {
    const published = parsePublished(manifest(), ddoc('sha256:root', LEAVES))
    const result = compare(published, rebuilt('sha256:other', { '/.well-known/orivon.json': 'sha256:01', '/index.html': 'sha256:XX', '/new.js': 'sha256:04' }))
    expect(result.match).toBe(false)
    expect(result.files).toEqual({ changed: ['/index.html'], onlyPublished: ['/app.js'], onlyRebuilt: ['/new.js'] })
  })

  it('is a mismatch when the bundle hashes agree but the CIDs, both known, do not', () => {
    const published = { ...parsePublished(manifest(), ddoc('sha256:root')), cid: 'bafyone' }
    expect(compare(published, rebuilt('sha256:root', LEAVES, { cid: 'bafytwo' })).match).toBe(false)
    expect(compare(published, rebuilt('sha256:root', LEAVES, { cid: 'bafyone' }))).toMatchObject({ match: true, cid: { match: true } })
  })

  it('does not call a CID a mismatch when only one side is known', () => {
    const result = compare(parsePublished(manifest(), ddoc('sha256:root')), rebuilt('sha256:root', LEAVES, { cid: 'bafyone' }))
    expect(result).toMatchObject({ match: true, cid: { rebuilt: 'bafyone' } })
    expect(result.cid.match).toBeUndefined()
  })
})

describe('formatReport', () => {
  const context = { app: 'demo', base: 'https://demo.orivonstack.eth.limo/', commit: COMMIT, commitFrom: 'manifest' as const }

  it('starts with MATCH and shows both hashes', () => {
    const built = rebuilt('sha256:root', LEAVES, { cid: 'bafyone' })
    const text = formatReport(context, built, compare(parsePublished(manifest(), ddoc('sha256:root')), built))
    expect(text.split('\n')[0]).toBe('[demo] MATCH')
    expect(text).toContain('bundleHash published  sha256:root')
    expect(text).toContain('bundleHash rebuilt    sha256:root  same')
    expect(text).toContain('CID rebuilt           bafyone  (ipfs add -r -H --cid-version=1 -Q)')
    expect(text).not.toContain('files whose content differs')
  })

  it('starts with MISMATCH, shows both values and lists the differing files', () => {
    const built = rebuilt('sha256:other', { ...LEAVES, '/index.html': 'sha256:XX' })
    const text = formatReport(context, built, compare(parsePublished(manifest(), ddoc('sha256:root')), built))
    expect(text.split('\n')[0]).toBe('[demo] MISMATCH')
    expect(text).toContain('bundleHash published  sha256:root')
    expect(text).toContain('bundleHash rebuilt    sha256:other  different')
    expect(text).toContain('files whose content differs (1):\n    /index.html')
    expect(text).toContain('CID rebuilt           not computed')
  })

  it('says where the commit came from', () => {
    const built = rebuilt('sha256:root')
    const result = compare(parsePublished(manifest(), ddoc('sha256:root')), built)
    expect(formatReport(context, built, result)).toContain("named by the published manifest's source.portsCommit")
    expect(formatReport({ ...context, commitFrom: 'flag' }, built, result)).toContain('given with --commit')
  })
})

describe('publishedBase', () => {
  it('serves the app\'s .eth name through eth.limo, or reads the address it is given', () => {
    expect(publishedBase('demo.orivonstack.eth', undefined)).toBe('https://demo.orivonstack.eth.limo/')
    expect(publishedBase('demo.orivonstack.eth', 'https://gateway.example/ipfs/bafy')).toBe('https://gateway.example/ipfs/bafy/')
  })

  it('refuses a plain-http address and an app with no .eth name', () => {
    expect(() => publishedBase('demo.orivonstack.eth', 'http://gateway.example/')).toThrow(/only https/)
    expect(() => publishedBase(undefined, undefined)).toThrow(/pass --from/)
  })
})

describe('verifyApp', () => {
  function deps (published: { manifest: string, ddoc: string, headers?: Record<string, string> }, built: Rebuilt): VerifyDeps & { asked: string[], commits: string[] } {
    const asked: string[] = []
    const commits: string[] = []
    return {
      asked,
      commits,
      fetchText: async (url: string): Promise<FetchedText> => {
        asked.push(url)
        if (url.endsWith('orivon-ddoc.json')) return { text: published.ddoc, headers: {} }
        return { text: published.manifest, headers: published.headers ?? {} }
      },
      rebuild: async (commit: string): Promise<Rebuilt> => { commits.push(commit); return built }
    }
  }

  it('reads both published files, rebuilds at the commit the manifest names, and reports MATCH', async () => {
    const wired = deps({ manifest: manifest({ source: { portsCommit: COMMIT } }), ddoc: ddoc('sha256:root') }, rebuilt('sha256:root'))
    const { report, comparison } = await verifyApp({ app: 'demo', domain: 'demo.orivonstack.eth' }, wired)
    expect(wired.asked).toEqual(['https://demo.orivonstack.eth.limo/.well-known/orivon.json', 'https://demo.orivonstack.eth.limo/.well-known/orivon-ddoc.json'])
    expect(wired.commits).toEqual([COMMIT])
    expect(comparison.match).toBe(true)
    expect(report).toMatch(/^\[demo\] MATCH/)
  })

  it('rebuilds at --commit instead when it is given, and reports MISMATCH', async () => {
    const wired = deps({ manifest: manifest({ source: { portsCommit: COMMIT } }), ddoc: ddoc('sha256:root') }, rebuilt('sha256:different'))
    const { report, comparison } = await verifyApp({ app: 'demo', domain: 'demo.orivonstack.eth', commit: OTHER }, wired)
    expect(wired.commits).toEqual([OTHER])
    expect(comparison.match).toBe(false)
    expect(report).toMatch(/^\[demo\] MISMATCH/)
    expect(report).toContain('given with --commit')
  })

  it('asks for --commit when the published manifest does not say which commit built it', async () => {
    const wired = deps({ manifest: manifest(), ddoc: ddoc('sha256:root') }, rebuilt('sha256:root'))
    await expect(verifyApp({ app: 'demo', domain: 'demo.orivonstack.eth' }, wired)).rejects.toThrow(/does not say which orivon-ports commit built it.*--commit/)
    expect(wired.commits).toEqual([])
  })

  it('rejects an abbreviated --commit before building anything', async () => {
    const wired = deps({ manifest: manifest(), ddoc: ddoc('sha256:root') }, rebuilt('sha256:root'))
    await expect(verifyApp({ app: 'demo', domain: 'demo.orivonstack.eth', commit: 'abc1234' }, wired)).rejects.toThrow(/full 40-character/)
    expect(wired.commits).toEqual([])
  })

  it('takes the published CID from --cid, else from the gateway\'s first root', async () => {
    const root = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
    const viaHeader = deps({ manifest: manifest({ source: { portsCommit: COMMIT } }), ddoc: ddoc('sha256:root'), headers: { 'x-ipfs-roots': `${root},bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku` } }, rebuilt('sha256:root', LEAVES, { cid: root }))
    expect((await verifyApp({ app: 'demo', domain: 'demo.orivonstack.eth' }, viaHeader)).comparison.cid).toEqual({ published: root, rebuilt: root, match: true })
    const other = 'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
    const flagged = deps({ manifest: manifest({ source: { portsCommit: COMMIT } }), ddoc: ddoc('sha256:root'), headers: { 'x-ipfs-roots': root } }, rebuilt('sha256:root', LEAVES, { cid: root }))
    expect((await verifyApp({ app: 'demo', domain: 'demo.orivonstack.eth', cid: other }, flagged)).comparison.cid.published).toBe(other)
  })
})

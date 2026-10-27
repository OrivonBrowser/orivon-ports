import { describe, expect, it } from 'vitest'
import { banner, chooseRecord, nameState, rowVerdict, summarise } from '../site/verdict.js'

const entry = (source: string, sequence: number, extra: Record<string, unknown> = {}) => ({
  source, sequence, value: `/ipfs/cid${sequence}`, cid: `cid${sequence}`, expires: new Date('2026-12-01T00:00:00Z'), expired: false, signature: 'valid', ...extra
})

describe('choosing the record', () => {
  it('takes the highest valid sequence and names the stale source', () => {
    const chosen = chooseRecord([entry('a', 16), entry('b', 15), entry('c', 16)])
    expect(chosen).toMatchObject({ status: 'ok', agreeing: 2, answered: 3, total: 3, stale: ['b'], conflicts: [] })
    expect(chosen.best?.source).toBe('a')
  })

  it('ignores a record with a bad signature, even at a higher sequence', () => {
    const chosen = chooseRecord([entry('a', 20, { signature: 'invalid' }), entry('b', 16)])
    expect(chosen.best?.sequence).toBe(16)
    expect(chosen.stale).toEqual([])
  })

  it('reports invalid when every answer is forged, and none when nobody answered', () => {
    expect(chooseRecord([entry('a', 5, { signature: 'invalid' })]).status).toBe('invalid')
    expect(chooseRecord([{ source: 'a', error: 'answered 504' }, { source: 'b', error: 'timeout' }])).toMatchObject({ status: 'none', best: null, answered: 0, total: 2 })
  })

  it('prefers a live record over a higher expired one, and reports expiry when all are expired', () => {
    expect(chooseRecord([entry('a', 9, { expired: true }), entry('b', 8)]).best?.sequence).toBe(8)
    expect(chooseRecord([entry('a', 9, { expired: true }), entry('b', 8, { expired: true })])).toMatchObject({ status: 'expired' })
  })

  it('flags two values at one sequence as a conflict', () => {
    expect(chooseRecord([entry('a', 7), entry('b', 7, { value: '/ipfs/other' })]).conflicts).toEqual(['b'])
  })
})

describe('a name against its key', () => {
  const key = 'k51qzi5uqu5dlswot3wcjo7k3vy02gepnrdw2qhu2a3f6ll422kykyoljjshuv'
  it('is ok only for this key', () => {
    expect(nameState({ status: 'found', contenthash: { kind: 'ipns', uri: `ipns://${key}`, cid: key } }, key).status).toBe('ok')
    expect(nameState({ status: 'found', contenthash: { kind: 'ipns', uri: 'ipns://k51other', cid: 'k51other' } }, key)).toEqual({ status: 'elsewhere', target: 'ipns://k51other' })
    expect(nameState({ status: 'found', contenthash: { kind: 'ipfs', uri: 'ipfs://bafyx', cid: 'bafyx' } }, key).status).toBe('elsewhere')
  })

  it('passes the other states through', () => {
    for (const status of ['noresolver', 'nocontenthash', 'unreachable']) expect(nameState({ status }, key)).toEqual({ status, target: null })
  })

  describe('a site with a Swarm feed', () => {
    const feed = 'fb21f431bc92f13bea4c9a16e255a2c9b9309d24258dd89bc0bb2d6284a32eb3'
    const swarm = (reference: string) => ({ status: 'found', contenthash: { kind: 'swarm', uri: `bzz://${reference}`, reference } })

    it('is ok at its ipns:// key or at its own feed, and says which', () => {
      expect(nameState({ status: 'found', contenthash: { kind: 'ipns', uri: `ipns://${key}`, cid: key } }, key, feed)).toEqual({ status: 'ok', target: `ipns://${key}`, via: 'ipns' })
      expect(nameState(swarm(feed), key, feed)).toEqual({ status: 'ok', target: `bzz://${feed}`, via: 'swarm' })
    })

    it('is elsewhere at another site\'s feed, and at any feed when the site has none', () => {
      const other = 'a'.repeat(64)
      expect(nameState(swarm(other), key, feed)).toEqual({ status: 'elsewhere', target: `bzz://${other}` })
      expect(nameState(swarm(feed), key)).toEqual({ status: 'elsewhere', target: `bzz://${feed}` })
    })

    it('stays elsewhere for an ipfs:// address and for a value that is not a manifest', () => {
      expect(nameState({ status: 'found', contenthash: { kind: 'ipfs', uri: 'ipfs://bafyx', cid: 'bafyx' } }, key, feed).status).toBe('elsewhere')
      expect(nameState({ status: 'found', contenthash: { kind: 'other', uri: 'bzz:// with a value that is not a manifest' } }, key, feed).status).toBe('elsewhere')
    })
  })
})

const goodRow = () => ({
  names: [{ name: 'a.orivonstack.eth', status: 'ok', target: 'ipns://k', detail: '' }],
  record: { status: 'ok', best: { expires: new Date('2026-12-01T00:00:00Z') } },
  content: { failure: null, warn: null },
  providers: { status: 'ok', count: 2, error: '' },
  ms: 4000
})

describe('a row verdict', () => {
  it('works when every step succeeded', () => {
    expect(rowVerdict(goodRow()).level).toBe('works')
  })

  it('is slow when it works but took over 15 s', () => {
    expect(rowVerdict({ ...goodRow(), ms: 16_000 }).level).toBe('slow')
  })

  it('names the first failing step in a sentence', () => {
    const noHash = { ...goodRow(), names: [{ name: 'attila.orivonstack.eth', status: 'nocontenthash' }] }
    expect(rowVerdict(noHash)).toEqual({ level: 'broken', text: 'attila.orivonstack.eth points at nothing' })
    const noResolver = { ...goodRow(), names: [{ name: 'latest.orivonstack.eth', status: 'noresolver' }] }
    expect(rowVerdict(noResolver).text).toBe('latest.orivonstack.eth has no resolver yet, so it points at nothing')
    const expired = { ...goodRow(), record: { status: 'expired', best: { expires: new Date('2026-10-01T08:30:00Z') } } }
    expect(rowVerdict(expired).text).toBe('The ipns:// record expired on 2026-10-01 08:30 UTC')
    const noPage = { ...goodRow(), content: { failure: 'No gateway could fetch the page (index.html)', warn: null } }
    expect(rowVerdict(noPage).text).toBe('No gateway could fetch the page (index.html)')
    const nobody = { ...goodRow(), providers: { status: 'ok', count: 0, error: '' } }
    expect(rowVerdict(nobody)).toEqual({ level: 'broken', text: 'Nobody announces this content on the public IPFS network' })
  })

  it('reports the earlier of two faults', () => {
    const both = { ...goodRow(), names: [{ name: 'x.eth', status: 'nocontenthash' }], providers: { status: 'ok', count: 0, error: '' } }
    expect(rowVerdict(both).text).toBe('x.eth points at nothing')
  })

  it('never calls a check it could not make working or broken', () => {
    const unreachable = { ...goodRow(), names: [{ name: 'x.eth', status: 'unreachable', detail: 'timeout' }] }
    expect(rowVerdict(unreachable).level).toBe('unsure')
    const noRouting = { ...goodRow(), providers: { status: 'error', count: 0, error: 'it timed out' } }
    expect(rowVerdict(noRouting).level).toBe('unsure')
    const sharded = { ...goodRow(), content: { failure: null, warn: 'Sharded folder: not checked' } }
    expect(rowVerdict(sharded)).toEqual({ level: 'unsure', text: 'Sharded folder: not checked' })
  })

  it('lets a real fault outrank a check that could not be made', () => {
    const mixed = { ...goodRow(), names: [{ name: 'x.eth', status: 'unreachable' }], providers: { status: 'ok', count: 0, error: '' } }
    expect(rowVerdict(mixed).level).toBe('broken')
  })
})

describe('the banner and the tiles', () => {
  const works = { label: 'A', verdict: { level: 'works', text: '' }, warnings: [] as string[] }
  const broken = { label: 'B', verdict: { level: 'broken', text: 'b.eth points at nothing' }, warnings: [] as string[] }

  it('is green only when everything works with no warning', () => {
    expect(banner([works, works]).level).toBe('ok')
  })

  it('is red and lists every broken row', () => {
    expect(banner([works, broken, { ...broken, label: 'C' }])).toMatchObject({ level: 'bad', lines: ['B: b.eth points at nothing', 'C: b.eth points at nothing'] })
  })

  it('is amber for slow, unsure and flagged rows, and waits for pending ones', () => {
    expect(banner([works, { ...works, verdict: { level: 'slow', text: 'slow' } }]).level).toBe('warn')
    expect(banner([{ ...works, warnings: ['b still serves an older copy'] }]).level).toBe('warn')
    expect(banner([works, { ...works, verdict: { level: 'pending', text: '' } }]).level).toBe('pending')
  })

  it('counts working sites, right names and served releases', () => {
    const rows = [
      { names: [{ status: 'ok' }, { status: 'ok' }], verdict: { level: 'works' } },
      { names: [{ status: 'noresolver' }], verdict: { level: 'broken' } },
      { names: [{ status: 'ok' }], verdict: { level: 'slow' } }
    ]
    const releases = [{ verdict: { level: 'works' }, kept: true }, { verdict: { level: 'broken' }, kept: true }]
    expect(summarise(rows, releases)).toEqual({ sites: { good: 2, total: 3 }, names: { good: 3, total: 4 }, releases: { good: 1, total: 2 } })
  })
})

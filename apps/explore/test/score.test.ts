import { describe, expect, it } from 'vitest'
import type { Site } from '../site/catalog.js'
import { SITES } from '../site/catalog.js'
import { SNAPSHOT } from '../site/judgements.js'
import { describeScore, identifiersOf, markOf, observedLevel, scoreOf, snapshotJudgement } from '../site/score.js'

const web: Site = { id: 'web', name: 'Web', category: 'a', summary: 's', web: 'https://web.example' }
const named: Site = { id: 'named', name: 'Named', category: 'a', summary: 's', web: 'https://named.example', ens: 'named.eth' }
const pinned: Site = { id: 'pinned', name: 'Pinned', category: 'a', summary: 's', ipfs: 'bafytest', orivon: { kind: 'port', published: true } }
const announced: Site = { id: 'soon', name: 'Soon', category: 'a', summary: 's', orivon: { kind: 'port', published: false } }
const judged = (level: number) => ({ level, provider: 'Test provider', read: null })

describe('the Web3 Score mark', () => {
  it('says Web2 at Level 1, Web2.5 at Levels 2 and 3, Web3 at Level 4, as the address bar does', () => {
    expect(([1, 2, 3, 4] as const).map(markOf)).toEqual(['Web2', 'Web2.5', 'Web2.5', 'Web3'])
  })

  it('observes Level 2 at an ENS name or an IPFS address, Level 1 at a web address alone', () => {
    expect(observedLevel(web)).toBe(1)
    expect(observedLevel(named)).toBe(2)
    expect(observedLevel(pinned)).toBe(2)
    expect(observedLevel(announced)).toBeNull()
    expect(scoreOf(announced, judged(4))).toBeNull()
  })

  it('lets a judged 3 or 4 raise a Level 2 site, naming who judged it', () => {
    expect(scoreOf(pinned, judged(4))).toEqual({ level: 4, mark: 'Web3', judgement: judged(4) })
    expect(scoreOf(pinned, judged(3))).toEqual({ level: 3, mark: 'Web2.5', judgement: judged(3) })
  })

  it('never lets a judgement lower an observed level or raise a Web2 site', () => {
    expect(scoreOf(pinned, judged(1))).toEqual({ level: 2, mark: 'Web2.5', judgement: null })
    expect(scoreOf(pinned, judged(2))).toEqual({ level: 2, mark: 'Web2.5', judgement: null })
    expect(scoreOf(web, judged(4))).toEqual({ level: 1, mark: 'Web2', judgement: null })
    expect(scoreOf(pinned, judged(5))).toEqual({ level: 2, mark: 'Web2.5', judgement: null })
    expect(scoreOf(named, null)).toEqual({ level: 2, mark: 'Web2.5', judgement: null })
  })

  it('says in words why, and who judged it and when', () => {
    expect(describeScore({ level: 1, mark: 'Web2', judgement: null })).toMatch(/^Website level 1 \(Web2\): an ordinary web address/)
    expect(describeScore({ level: 2, mark: 'Web2.5', judgement: null })).toMatch(/^Website level 2 \(Web2\.5\): Orivon checks every file/)
    expect(describeScore({ level: 4, mark: 'Web3', judgement: judged(4) })).toBe('Website level 4 (Web3), judged by Test provider')
    expect(describeScore({ level: 3, mark: 'Web2.5', judgement: { level: 3, provider: 'P', read: '2026-10-05' } })).toBe('Website level 3 (Web2.5), judged by P on 2026-10-05')
  })

  it('looks a site up by the CID it is listed at', () => {
    expect(identifiersOf(pinned)).toEqual(['cid:bafytest'])
    expect(identifiersOf(named)).toEqual([])
    const snapshot = { provider: 'P', read: '2026-10-05', website: { 'cid:bafytest': 4 } }
    expect(snapshotJudgement(pinned, snapshot)).toEqual({ level: 4, provider: 'P', read: '2026-10-05' })
    expect(snapshotJudgement(named, snapshot)).toBeNull()
  })

  it('looks a .eth site up by its name, as the snapshot judged it on its day', () => {
    const snapshot = { provider: 'P', read: '2026-10-05', website: {}, ens: { 'named.eth': { cid: 'bafyname', level: 3 } } }
    expect(snapshotJudgement(named, snapshot)).toEqual({ level: 3, provider: 'P', read: '2026-10-05' })
    expect(snapshotJudgement({ ...named, ens: 'other.eth' }, snapshot)).toBeNull()
    expect(snapshotJudgement({ ...named, ens: 'constructor' }, snapshot)).toBeNull()
  })
})

describe('the snapshot', () => {
  // A port rebuilt at a new CID is new content; its old judgement must not follow it.
  it('judges only CIDs the catalog lists, each at a level the standard has', () => {
    const listed = new Set(SITES.flatMap(identifiersOf))
    for (const [id, level] of Object.entries(SNAPSHOT.website)) {
      expect(listed.has(id), `${id} is not a CID in catalog.js`).toBe(true)
      expect([1, 2, 3, 4], id).toContain(level)
    }
  })

  // A name whose site left the catalog must not keep a judgement nobody can see or refresh.
  it('judges only .eth names the catalog lists, each with the CID it judged', () => {
    const names = new Set(SITES.flatMap((site) => (site.ens ? [site.ens] : [])))
    for (const [name, entry] of Object.entries(SNAPSHOT.ens)) {
      expect(names.has(name), `${name} is not a .eth name in catalog.js`).toBe(true)
      expect(entry.cid, name).toMatch(/^baf[a-z2-7]{50,}$/)
      expect([1, 2, 3, 4], name).toContain(entry.level)
    }
  })

  it('names its provider, the address it was read from and the day', () => {
    expect(SNAPSHOT.provider).not.toBe('')
    expect(SNAPSHOT.address).toMatch(/^(ipns|ipfs|https):\/\/\S+\/score$/)
    expect(SNAPSHOT.read).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

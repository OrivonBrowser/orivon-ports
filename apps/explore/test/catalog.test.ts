import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { CATEGORIES, SITES } from '../site/catalog.js'

describe('the catalog', () => {
  it('has unique kebab-case ids, for categories and sites alike', () => {
    for (const list of [CATEGORIES, SITES]) {
      const ids = list.map((entry) => entry.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })

  it('files every site under a category that exists, and every category has a site', () => {
    const known = new Set(CATEGORIES.map((category) => category.id))
    for (const site of SITES) expect(known.has(site.category), `${site.id} -> ${site.category}`).toBe(true)
    for (const category of CATEGORIES) {
      expect(SITES.some((site) => site.category === category.id), category.id).toBe(true)
    }
  })

  it('gives every site an address, and every address its right shape', () => {
    for (const site of SITES) {
      if (site.web !== undefined) expect(site.web, site.id).toMatch(/^https:\/\/[^\s/]+(\/\S*)?$/)
      if (site.ens !== undefined) expect(site.ens, site.id).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/)
      if (site.ipfs !== undefined) expect(site.ipfs, site.id).toMatch(/^baf[a-z2-7]{50,}$/)
      if (site.ipns !== undefined) expect(site.ipns, site.id).toMatch(/^k51[a-z0-9]{59}$/)
    }
  })

  it('gives every published port an ipns name, so a new build needs no catalog change', () => {
    for (const site of SITES.filter((s) => s.orivon?.kind === 'port' && s.orivon.published !== false)) {
      expect(site.ipns, site.id).toBeDefined()
    }
  })

  // An announced app is the only listing that may have nowhere to go yet.
  it('never gives a web address that is only the gateway form of the site\'s own ENS name', () => {
    for (const site of SITES) {
      if (!site.web || !site.ens) continue
      expect(new URL(site.web).host, site.id).not.toBe(`${site.ens}.limo`)
    }
  })

  it('lets only an announced Orivon app go without an address', () => {
    for (const site of SITES) {
      const hasAddress = site.web !== undefined || site.ens !== undefined || site.ipfs !== undefined
      if (site.orivon?.published === false) expect(hasAddress, `${site.id} is announced but has an address`).toBe(false)
      else expect(hasAddress, `${site.id} has no address`).toBe(true)
    }
    const published = SITES.filter((site) => site.orivon && site.orivon.published !== false)
    expect(published.length).toBeGreaterThan(0)
  })

  it('lists the six ports, each naming the project it was ported from', () => {
    const ports = SITES.filter((site) => site.orivon?.kind === 'port')
    expect(ports.map((site) => site.id).sort()).toEqual(['airgapvault', 'asgardex', 'element', 'freetube', 'thelounge', 'webtorrent'])
    for (const site of ports) {
      expect(site.orivon?.upstream, site.id).toMatch(/^https:\/\/[^\s/]+(\/\S*)?$/)
      expect(site.orivon?.published, site.id).toBeTypeOf('boolean')
    }
  })

  it('marks Orivon apps with a known kind, and says needsOrivon only when it means it', () => {
    const marked = SITES.filter((site) => site.orivon)
    expect(marked.length).toBeGreaterThan(0)
    for (const site of marked) {
      expect(['native', 'port']).toContain(site.orivon?.kind)
      if (site.orivon?.needsOrivon !== undefined) expect(site.orivon.needsOrivon).toBe(true)
    }
  })

  it('keeps summaries short and written alike: under 90 characters, no closing period', () => {
    for (const site of SITES) {
      expect(site.summary.length, site.id).toBeLessThan(90)
      expect(site.summary, site.id).not.toMatch(/[.!?]$/)
      expect(site.summary, site.id).toBe(site.summary.trim())
    }
  })

  // A card's tile is an icon file named after the site's id and referenced relatively, so the
  // page fetches nothing beyond its own origin: one file each way, never a missing tile.
  it('gives every site its own icon, and every icon a site', async () => {
    const files = await readdir(new URL('../site/icons/', import.meta.url))
    expect(files.sort()).toEqual(SITES.map((site) => `${site.id}.png`).sort())
  })

  // The icons are the sites' own marks, so each one says where it came from, or that it is ours.
  it('names the source of every icon in UPSTREAM.md, and of no other', async () => {
    const text = await readFile(new URL('../UPSTREAM.md', import.meta.url), 'utf8')
    const rows = [...text.matchAll(/^\| `([a-z0-9-]+)` \| (.+?) \|$/gm)]
    expect(rows.map(([, id]) => id).sort()).toEqual(SITES.map((site) => site.id).sort())
    for (const [, id, source] of rows) expect(source, id).toMatch(/^(?:<(?:https|ipfs):\/\/\S+>|drawn here)$/)
  })
})

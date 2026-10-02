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

  it('lists the five ports, each naming the project it was ported from', () => {
    const ports = SITES.filter((site) => site.orivon?.kind === 'port')
    expect(ports.map((site) => site.id).sort()).toEqual(['airgapvault', 'asgardex', 'element', 'freetube', 'thelounge'])
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
})

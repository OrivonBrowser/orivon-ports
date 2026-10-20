import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parseCid } from '../site/cid.js'
import { GATEWAYS, HOSTS, RECORD_GATEWAYS, RPCS, SCORE_PROVIDER, SITES } from '../site/targets.js'

const manifest = JSON.parse(await readFile(new URL('../orivon.json', import.meta.url), 'utf8'))
const recipe = JSON.parse(await readFile(new URL('../recipe.json', import.meta.url), 'utf8'))

describe('the manifest', () => {
  it('declares one capability: https to exactly the hosts the page contacts', () => {
    expect(Object.keys(manifest.capabilities)).toEqual(['net'])
    expect(Object.keys(manifest.capabilities.net)).toEqual(['https'])
    expect(Object.keys(manifest.capabilities.net.https)).toEqual(['connect'])
    expect(manifest.capabilities.net.https.connect).toEqual(HOSTS.map((host) => `${host}:443`).sort())
  })

  it('names the same origin as the recipe', () => {
    expect(manifest.domain).toBe(recipe.eth)
    expect(manifest.id).toBe('eth.orivonstack.status')
    expect(manifest.consentGranularity).toBe('per-capability')
  })
})

describe('the targets', () => {
  it('lists one valid IPNS key per row, each with unique ids and names', () => {
    expect(new Set(SITES.map((site) => site.id)).size).toBe(SITES.length)
    expect(new Set(SITES.flatMap((site) => site.names)).size).toBe(SITES.flatMap((site) => site.names).length)
    for (const site of SITES) {
      expect(parseCid(site.ipns).codec).toBe(0x72)
      for (const name of site.names) expect(name).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/)
    }
  })

  it('serves records from gateways that are also block gateways', () => {
    for (const gateway of RECORD_GATEWAYS) expect(GATEWAYS).toContain(gateway)
    for (const url of [...GATEWAYS, ...RPCS]) expect(url).toMatch(/^https:\/\/[a-z.-]+$/)
  })

  // The page reads each port's pin from the recipe on the ports repository's main branch, so a row's `port` has to be a
  // real app there, and a port with no row would be a pin nobody sees.
  it('gives every somebody-else\'s app a row, and every row\'s port a recipe', async () => {
    const apps = new URL('../../', import.meta.url)
    const ports: string[] = []
    for (const id of await readdir(apps)) {
      const recipe = JSON.parse(await readFile(new URL(`${id}/recipe.json`, apps), 'utf8'))
      if (recipe.upstream) ports.push(id)
    }
    expect(SITES.flatMap((site) => site.port ? [site.port] : []).sort()).toEqual(ports.sort())
  })

  it('reads the Web3 Score from the provider row it also checks', () => {
    expect(SITES.find((site) => site.id === 'web3-score')?.ipns).toBe(SCORE_PROVIDER.key)
  })

  it('names no pinning server', () => {
    expect(JSON.stringify({ SITES, GATEWAYS, RPCS, HOSTS })).not.toMatch(/152\.228|12D3Koo|telemetry/)
  })
})

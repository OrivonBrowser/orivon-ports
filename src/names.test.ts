import { describe, expect, it } from 'vitest'
import { generateNamesJson, generatePac, namedApps } from './names.ts'
import type { Recipe } from './recipe.ts'

const recipe = (id: string, port: number, eth?: string): Recipe => ({
  id,
  name: id,
  port,
  upstream: { repo: 'https://example.com/x.git', ref: '0'.repeat(40), licence: 'MIT' },
  build: { command: 'true', output: 'dist' },
  manifest: 'orivon.json',
  entry: 'index.html',
  extraFiles: [],
  ...(eth === undefined ? {} : { eth })
})

describe('namedApps', () => {
  it('keeps only recipes with an eth name, in the order given', () => {
    const recipes = [recipe('asgardex', 8876, 'asgardex.eth'), recipe('bare', 8877), recipe('freetube', 8875, 'freetube.eth')]
    expect(namedApps(recipes)).toEqual([
      { name: 'asgardex.eth', port: 8876 },
      { name: 'freetube.eth', port: 8875 }
    ])
  })

  it('returns nothing when no recipe declares a name', () => {
    expect(namedApps([recipe('bare', 8877)])).toEqual([])
  })

  // parseRecipe already refuses this shape, so a real recipe can never carry
  // it -- this is the defense-in-depth layer for whatever bypasses that,
  // since this function's own output becomes PAC source text.
  it('throws on a shape parseRecipe would have refused, naming the app', () => {
    const bad = recipe('freetube', 8875, 'Not-Valid') as Recipe
    expect(() => namedApps([bad])).toThrow(/freetube/)
  })
})

/** Evaluates generated PAC source the way Chromium would, and calls it. */
function findProxy (pac: string, host: string): string {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- exercising real PAC source, not user input
  const fn = new Function(`${pac}\nreturn FindProxyForURL;`)() as (url: string, host: string) => string
  return fn(`http://${host}/`, host)
}

describe('generatePac', () => {
  const apps = [{ name: 'freetube.eth', port: 8875 }, { name: 'asgardex.eth', port: 8876 }]

  it('proxies each declared name to its own port', () => {
    expect(findProxy(generatePac(apps), 'freetube.eth')).toBe('PROXY 127.0.0.1:8875')
    expect(findProxy(generatePac(apps), 'asgardex.eth')).toBe('PROXY 127.0.0.1:8876')
  })

  it('sends everything else DIRECT, including an ordinary site', () => {
    expect(findProxy(generatePac(apps), 'example.com')).toBe('DIRECT')
  })

  // An exact-match table, not a substring test: a name containing or
  // extending a declared one must not match it.
  it('does not match a name that merely contains a declared one', () => {
    expect(findProxy(generatePac(apps), 'notfreetube.eth')).toBe('DIRECT')
    expect(findProxy(generatePac(apps), 'freetube.eth.evil.com')).toBe('DIRECT')
  })

  it('matches case-insensitively, the way a browser lowercases a typed host', () => {
    expect(findProxy(generatePac(apps), 'FreeTube.ETH')).toBe('PROXY 127.0.0.1:8875')
  })

  it('omits an app with no name entirely', () => {
    expect(generatePac([])).not.toContain('PROXY')
    expect(findProxy(generatePac([]), 'freetube.eth')).toBe('DIRECT')
  })

  // `namedApps` already refuses this shape (ETH_NAME has no room for a quote),
  // so this drives `generatePac` directly -- it is the layer that turns a
  // name into JavaScript SOURCE, and it must not trust that every caller
  // routed through `namedApps` first.
  it('keeps a quote or backslash from breaking out of the generated source', () => {
    const hostile = [{ name: '"};FindProxyForURL=function(){return "PROXY evil:1"};var x={"', port: 8875 }]
    const pac = generatePac(hostile)
    expect(() => new Function(pac)).not.toThrow()
    // A hostile key can never be typed as a host, so it never matches --
    // the only claim this test makes is that it FAILED TO ESCAPE THE SOURCE,
    // not that it proxied anything.
    expect(findProxy(pac, 'freetube.eth')).toBe('DIRECT')
  })
})

describe('generateNamesJson', () => {
  it('maps each declared name to its port', () => {
    const apps = [{ name: 'freetube.eth', port: 8875 }, { name: 'asgardex.eth', port: 8876 }]
    expect(JSON.parse(generateNamesJson(apps))).toEqual({ 'freetube.eth': 8875, 'asgardex.eth': 8876 })
  })

  it('is an empty object when nothing declares a name', () => {
    expect(JSON.parse(generateNamesJson([]))).toEqual({})
  })
})

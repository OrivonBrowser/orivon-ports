import { describe, expect, it } from 'vitest'
import { buildHash, pageKey, parseHash } from '../site/router.js'
import { hue, initials } from '../site/monogram.js'

const ids = ['exchange', 'wallets']

describe('router', () => {
  it('reads each route, with and without a search', () => {
    expect(parseHash('', ids)).toEqual({ view: 'directory', category: null, orivonOnly: false, q: '' })
    expect(parseHash('#/c/wallets', ids).category).toBe('wallets')
    expect(parseHash('#/orivon?q=lounge', ids)).toEqual({ view: 'directory', category: null, orivonOnly: true, q: 'lounge' })
    expect(parseHash('#/?q=a%20b', ids).q).toBe('a b')
    expect(parseHash('#/lab', ids).view).toBe('lab')
  })

  it('falls back to all sites for a category it does not know', () => {
    expect(parseHash('#/c/nope', ids).category).toBeNull()
  })

  it('round-trips through buildHash', () => {
    for (const hash of ['#/', '#/c/exchange', '#/orivon', '#/lab', '#/c/wallets?q=safe', '#/?q=a+b']) {
      expect(buildHash(parseHash(hash, ids))).toBe(hash)
    }
  })

  it('treats two searches on one page as the same page', () => {
    expect(pageKey(parseHash('#/c/exchange?q=a', ids))).toBe(pageKey(parseHash('#/c/exchange?q=b', ids)))
    expect(pageKey(parseHash('#/c/exchange', ids))).not.toBe(pageKey(parseHash('#/', ids)))
  })
})

describe('monogram', () => {
  it('takes initials from words, or the first two letters of one', () => {
    expect(initials('CoW Swap')).toBe('CS')
    expect(initials('Uniswap')).toBe('Un')
    expect(initials('ethereum.org')).toBe('EO')
    expect(initials("Vitalik Buterin's blog")).toBe('VB')
  })

  it('derives a stable hue in range', () => {
    expect(hue('uniswap')).toBe(hue('uniswap'))
    for (const id of ['a', 'curve', 'a-very-long-site-identifier']) {
      expect(hue(id)).toBeGreaterThanOrEqual(0)
      expect(hue(id)).toBeLessThan(360)
    }
  })
})

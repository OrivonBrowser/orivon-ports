import { describe, expect, it } from 'vitest'
import { browsedSection, buildHash, pageKey, parseHash } from '../site/router.js'
import { hue, initials } from '../site/monogram.js'

const ids = ['exchange', 'wallets']

describe('router', () => {
  const directory = { view: 'directory', category: null, q: '', web2: false }

  it('opens on the Web3 sites, and reads each section', () => {
    expect(parseHash('', ids)).toEqual({ ...directory, section: 'web3' })
    expect(parseHash('#/', ids)).toEqual({ ...directory, section: 'web3' })
    expect(parseHash('#/web2', ids)).toEqual({ ...directory, section: 'web2' })
    expect(parseHash('#/all', ids)).toEqual({ ...directory, section: 'all' })
    expect(parseHash('#/orivon', ids)).toEqual({ ...directory, section: 'orivon' })
    expect(parseHash('#/lab', ids).view).toBe('lab')
  })

  it('reads a category inside its section, and none inside the Orivon apps', () => {
    expect(parseHash('#/c/wallets', ids)).toEqual({ ...directory, section: 'web3', category: 'wallets' })
    expect(parseHash('#/web2/c/wallets', ids)).toEqual({ ...directory, section: 'web2', category: 'wallets' })
    expect(parseHash('#/all/c/exchange', ids)).toEqual({ ...directory, section: 'all', category: 'exchange' })
    expect(parseHash('#/orivon/c/wallets', ids)).toEqual({ ...directory, section: 'orivon' })
  })

  it('falls back to the section for a category it does not know', () => {
    expect(parseHash('#/c/nope', ids)).toEqual({ ...directory, section: 'web3' })
    expect(parseHash('#/web2/c/nope', ids)).toEqual({ ...directory, section: 'web2' })
  })

  it('reads a search, with Include Web2 off unless the address turns it on', () => {
    expect(parseHash('#/search?q=a%20b', ids)).toEqual({ ...directory, view: 'search', section: 'web3', q: 'a b' })
    expect(parseHash('#/search?q=swap&web2=1', ids).web2).toBe(true)
    expect(parseHash('#/search?q=swap&web2=0', ids).web2).toBe(false)
    expect(parseHash('#/search?q=%20', ids)).toEqual({ ...directory, section: 'web3' })
  })

  it('still finds what an older search link asked for', () => {
    expect(parseHash('#/?q=lounge', ids)).toMatchObject({ view: 'search', q: 'lounge' })
    expect(parseHash('#/c/wallets?q=safe', ids)).toMatchObject({ view: 'search', q: 'safe', category: null })
    expect(parseHash('#/orivon?q=lounge', ids)).toMatchObject({ view: 'search', q: 'lounge' })
  })

  it('round-trips through buildHash', () => {
    for (const hash of ['#/', '#/web2', '#/all', '#/orivon', '#/c/exchange', '#/web2/c/wallets', '#/all/c/exchange', '#/lab', '#/search?q=a+b', '#/search?q=swap&web2=1']) {
      expect(buildHash(parseHash(hash, ids))).toBe(hash)
    }
  })

  it('treats every search as one page, and each section and category as its own', () => {
    expect(pageKey(parseHash('#/search?q=a', ids))).toBe(pageKey(parseHash('#/search?q=b&web2=1', ids)))
    expect(pageKey(parseHash('#/c/exchange', ids))).not.toBe(pageKey(parseHash('#/web2/c/exchange', ids)))
    expect(pageKey(parseHash('#/', ids))).not.toBe(pageKey(parseHash('#/all', ids)))
  })

  it('keeps category links in the section being browsed, and in Web3 sites from anywhere else', () => {
    expect(browsedSection(parseHash('#/web2', ids))).toBe('web2')
    expect(browsedSection(parseHash('#/all/c/exchange', ids))).toBe('all')
    expect(browsedSection(parseHash('#/orivon', ids))).toBe('web3')
    expect(browsedSection(parseHash('#/search?q=x&web2=1', ids))).toBe('web3')
    expect(browsedSection(parseHash('#/lab', ids))).toBe('web3')
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

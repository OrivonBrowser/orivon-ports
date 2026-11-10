// The bridge page's entry: it hands runBridge what the browser says (the address, the referrer, whether it is framed, the storage) and
// takes the fragment out of the address bar. bridge.js is tested apart with all of that given; this is the part that reads it off the page.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PENDING_KEY, type Pending } from '../site/sdk/pending.js'
import { ID_ORIGIN } from '../site/sdk/protocol.js'
import { memoryStore } from './support/signin-flow.ts'
import { ORIGIN } from './support/signin-world.ts'

const C = 'Ab3dEf6hIj9lMn2pQr5tUv8xYz1BcDeF'
const NONCE = 'k3Jf92LmQp0xZ7aT'

/** The globals a bridge page reads, stood in for, and a record of what it did to them. */
function browser (options: { framed?: boolean, search?: string, hash?: string, referrer?: string, replaceStateFails?: boolean } = {}) {
  const storage = memoryStore()
  const pending: Pending = { v: 2, origin: ORIGIN, nonce: NONCE, key: null, ttl: null, state: 'st-1', after: '/signed-in', at: Math.floor(Date.now() / 1000) }
  storage.setItem(PENDING_KEY, JSON.stringify(pending))
  const navigated: string[] = []
  const rewritten: unknown[][] = []
  const posted: unknown[] = []
  const status = { textContent: 'Orivon ID sign-in' }
  const self: { top: unknown } = { top: null }
  self.top = options.framed === true ? {} : self
  vi.stubGlobal('window', self)
  vi.stubGlobal('location', {
    origin: ORIGIN, pathname: '/.well-known/orivon-id/bridge.html', search: options.search ?? '', hash: options.hash ?? '',
    replace: (url: string) => { navigated.push(url) }
  })
  vi.stubGlobal('document', { referrer: options.referrer ?? `${ID_ORIGIN}/`, getElementById: (id: string) => id === 'status' ? status : null })
  vi.stubGlobal('history', {
    replaceState: (...args: unknown[]) => {
      if (options.replaceStateFails === true) throw new Error('security')
      rewritten.push(args)
    }
  })
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('BroadcastChannel', class { postMessage (message: unknown) { posted.push(message) } })
  return { storage, navigated, rewritten, posted, status }
}

const start = async () => {
  vi.resetModules()
  await import('../site/sdk/bridge-start.js')
}

afterEach(() => { vi.unstubAllGlobals() })

describe('the bridge page reads the browser', () => {
  it('forwards what the site kept, for a visit whose referrer is the ID site, and says so on the page', async () => {
    const page = browser({ search: `?c=${C}` })
    await start()
    expect(page.navigated).toEqual([`${ID_ORIGIN}/#/connect?v=2&c=${C}&nonce=${NONCE}&state=st-1`])
    expect(page.status.textContent).toBe('Continuing your sign-in…')
    expect(page.rewritten).toEqual([])
  })

  it.each([
    ['a visit for the ID site', { search: `?c=${C}` }],
    ['an answer', { hash: '#orivonid-error=cancelled&state=st-1' }]
  ])('does nothing inside a frame: %s', async (_name, where) => {
    const page = browser({ framed: true, ...where })
    await start()
    expect(page.navigated).toEqual([])
    expect(page.rewritten).toEqual([])
    expect(page.posted).toEqual([])
    expect(page.storage.getItem('orivonid.answer')).toBeNull()
    expect(page.status.textContent).toBe('This page cannot be used inside another page.')
  })

  it('takes the fragment out of the address bar and the history before the answer is read, and lands it', async () => {
    const page = browser({ hash: '#orivonid-error=cancelled&state=st-1' })
    await start()
    expect(page.rewritten).toEqual([[null, '', '/.well-known/orivon-id/bridge.html']])
    expect(page.navigated).toEqual(['/signed-in'])
    expect(page.posted).toEqual([{ kind: 'answer' }])
    expect(page.storage.getItem('orivonid.answer')).not.toBeNull()
    expect(page.status.textContent).toBe('Signed in with Orivon ID. Taking you back to the site…')
  })

  it('keeps the query when it takes the fragment out', async () => {
    const page = browser({ search: '?x=1', hash: '#orivonid-error=cancelled&state=st-1' })
    await start()
    expect(page.rewritten).toEqual([[null, '', '/.well-known/orivon-id/bridge.html?x=1']])
  })

  it('goes on when the browser will not rewrite the address bar: the page is about to leave it', async () => {
    const page = browser({ hash: '#orivonid-error=cancelled&state=st-1', replaceStateFails: true })
    await start()
    expect(page.navigated).toEqual(['/signed-in'])
    expect(page.status.textContent).toBe('Signed in with Orivon ID. Taking you back to the site…')
  })

  it('reads the referrer from the document: a visit that did not come from the ID site is not forwarded', async () => {
    const page = browser({ search: `?c=${C}`, referrer: 'https://evil.example/' })
    await start()
    expect(page.navigated).toEqual([])
    expect(page.status.textContent).toBe('This page is opened by the Orivon ID sign-in. Your browser did not say that it came from there.')
  })
})

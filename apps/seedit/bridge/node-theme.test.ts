// bridge/node-theme.js in a realm that holds a fake document: the dashboard page wears the class seedit's own page wears, from the same stored value.
// seedit keeps the choice in localStorage `theme` ('light' when nothing is stored: src/stores/use-theme-store.ts) and its App effect (src/app.tsx) removes
// every class of the body and adds that one; the settings page offers 'light' and 'dark' only.
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = await readFile(new URL('./node-theme.js', import.meta.url), 'utf8')

interface Body { className: string }

/** A page whose body is already there (the script ran late) or is inserted later, which the observer reports. */
function realm (options: { stored?: string | null, storage?: 'works' | 'throws' | 'missing', body?: 'present' | 'later', startClass?: string }) {
  const { stored = null, storage = 'works', body = 'present', startClass = 'dark' } = options
  const element: Body = { className: startClass }
  const calls = { observed: 0, disconnected: 0 }
  let report: (() => void) | undefined
  const document: { body: Body | null, documentElement: object } = { body: body === 'present' ? element : null, documentElement: {} }
  class FakeObserver {
    constructor (callback: () => void) { report = callback }
    observe (target: object, init: { childList?: boolean }): void { expect(target).toBe(document.documentElement); expect(init).toEqual({ childList: true }); calls.observed += 1 }
    disconnect (): void { calls.disconnected += 1 }
  }
  const localStorage = storage === 'works'
    ? { getItem: (key: string) => (key === 'theme' ? stored : null) }
    : { getItem: () => { throw new Error('storage is blocked') } }
  const sandbox: Record<string, unknown> = { document, MutationObserver: FakeObserver }
  if (storage !== 'missing') sandbox['localStorage'] = localStorage
  vm.runInNewContext(source, sandbox)
  return {
    element,
    calls,
    /** The observer reports a change of the document that is not the body (the head's own children arrive that way). */
    fire (): void { report?.() },
    /** The parser inserts the body, and the observer says so. */
    insertBody (): void { document.body = element; report?.() }
  }
}

describe('the class the dashboard wears', () => {
  it('is light when nothing is stored, as seedit\'s own page is: its store falls back to "light"', () => {
    expect(realm({ stored: null }).element.className).toBe('light')
    expect(realm({ stored: '' }).element.className).toBe('light')
  })

  it('is the stored theme, the only class of the body, as seedit\'s own effect leaves it', () => {
    expect(realm({ stored: 'dark', startClass: 'light' }).element.className).toBe('dark')
    expect(realm({ stored: 'light', startClass: 'dark' }).element.className).toBe('light')
    expect(realm({ stored: 'dark', startClass: 'light other' }).element.className).toBe('dark')
  })

  it('stays what the page was written with when the stored value is neither light nor dark, which seedit\'s own static shell also ignores', () => {
    expect(realm({ stored: 'blue' }).element.className).toBe('dark')
    expect(realm({ stored: '{"theme":"dark"}' }).element.className).toBe('dark')
  })

  it('stays what the page was written with when storage cannot be read', () => {
    expect(realm({ storage: 'throws' }).element.className).toBe('dark')
    expect(realm({ storage: 'missing' }).element.className).toBe('dark')
  })
})

describe('when the class goes on', () => {
  it('is at once when the body is there, with nothing to wait for', () => {
    const page = realm({ stored: 'light' })
    expect(page.element.className).toBe('light')
    expect(page.calls).toEqual({ observed: 0, disconnected: 0 })
  })

  it('is the moment the parser inserts the body, when the script runs in the head, and the wait ends', () => {
    const page = realm({ stored: 'light', body: 'later' })
    expect(page.element.className).toBe('dark')
    expect(page.calls).toEqual({ observed: 1, disconnected: 0 })
    page.insertBody()
    expect(page.element.className).toBe('light')
    expect(page.calls).toEqual({ observed: 1, disconnected: 1 })
  })

  it('waits on through a change that is not the body, and then goes on', () => {
    const page = realm({ stored: 'light', body: 'later' })
    page.fire()
    expect(page.element.className).toBe('dark')
    expect(page.calls.disconnected).toBe(0)
    page.insertBody()
    expect(page.element.className).toBe('light')
    expect(page.calls.disconnected).toBe(1)
  })
})

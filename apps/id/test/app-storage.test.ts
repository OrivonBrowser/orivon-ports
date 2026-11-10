// The tab's own storage: the one place the ID site keeps the challenge of a sign-in, apart from the site's `localStorage`, so that a
// second tab never reads another tab's challenge.

import { describe, expect, it } from 'vitest'
import { createApp } from '../site/app.js'
import { memoryStore } from './support/signin-flow.ts'

describe('the tab storage of the app', () => {
  it('is the tab\'s sessionStorage, and never the localStorage the whole site shares', () => {
    const tab = memoryStore()
    const site = memoryStore()
    const app = createApp({ sessionStorage: tab, localStorage: site })
    expect(app.tabStorage).toBe(tab)
    expect(app.tabStorage).not.toBe(site)
  })

  it('is none when the browser has no sessionStorage or refuses it', () => {
    const site = memoryStore()
    expect(createApp({ localStorage: site }).tabStorage).toBeNull()
    expect(createApp({ localStorage: site, get sessionStorage () { throw new Error('blocked') } }).tabStorage).toBeNull()
  })
})

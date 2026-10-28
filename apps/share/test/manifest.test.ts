import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../orivon.json', import.meta.url), 'utf8')) as { capabilities: { net: { concurrentSockets: number } } }

describe('the manifest\'s socket budget', () => {
  it('covers every connection the page\'s IPFS node may hold, with room for the page\'s own sockets', () => {
    // The node opens at most 128 connections and accepts at most 64, with 32 more being set up; they all count against
    // the page's origin, as do its two listeners, its calls to the node's API and its tracker sockets. A budget below
    // the sum made the node's API socket fail while it announced a large share. Orivon's ceiling is 512.
    const node = 128 + 64 + 32
    const own = 2 + 4 + 8
    const budget = manifest.capabilities.net.concurrentSockets
    expect(budget).toBeGreaterThanOrEqual(node + own)
    expect(budget).toBeLessThanOrEqual(512)
  })
})

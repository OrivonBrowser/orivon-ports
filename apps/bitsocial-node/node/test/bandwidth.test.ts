// The node's byte counts, as the page API passes them on: only from a node whose features name `bandwidth`, only numbers, and the
// feature list read once it has been read.
import { describe, expect, it } from 'vitest'
import { bandwidthReader } from '../worker/bandwidth.js'

const TRAFFIC = { TotalIn: 100, TotalOut: 50, RateIn: 3, RateOut: 1 }

function node (options: { features?: string | null, answer?: () => Response } = {}) {
  const asked: string[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    asked.push(`${path} ${new Headers(init?.headers).get('x-orivon-key') ?? ''}`)
    if (path === '/health') {
      if (options.features === null) throw new TypeError('fetch failed')
      return new Response('ok\n', { headers: options.features === undefined ? {} : { 'x-orivon-node-features': options.features } })
    }
    if (path === '/orivon/stats/bw') return (options.answer ?? (() => Response.json(TRAFFIC)))()
    return new Response('', { status: 404 })
  }) as unknown as typeof globalThis.fetch
  return { asked, read: bandwidthReader({ fetch, base: 'http://node.test', key: 'k' }) }
}

describe('bandwidthReader', () => {
  it('reads the route of a node that names the feature, with the key', async () => {
    const run = node({ features: 'add,pin,bandwidth,ipns-pubsub' })
    expect(await run.read()).toEqual(TRAFFIC)
    expect(run.asked).toEqual(['/health k', '/orivon/stats/bw k'])
  })

  it('reads the feature list once, and the route at every call', async () => {
    const run = node({ features: 'bandwidth' })
    await run.read()
    await run.read()
    expect(run.asked.filter((one) => one.startsWith('/health'))).toHaveLength(1)
    expect(run.asked.filter((one) => one.startsWith('/orivon/stats/bw'))).toHaveLength(2)
  })

  it.each([['a node with no features header', undefined], ['a node with other features', 'add,pin,car'], ['a feature that only starts like it', 'bandwidth-limit,xbandwidth']])('leaves %s to the nulls, and never asks the route', async (_what, features) => {
    const run = node({ ...(features === undefined ? {} : { features }) })
    expect(await run.read()).toBeNull()
    expect(run.asked.some((one) => one.startsWith('/orivon/stats/bw'))).toBe(false)
  })

  it('asks again for the features after a node that did not answer, and gives null meanwhile', async () => {
    let up = false
    const asked: string[] = []
    const fetch = (async (url: string) => {
      asked.push(new URL(url).pathname)
      if (!up) throw new TypeError('fetch failed')
      return new URL(url).pathname === '/health' ? new Response('ok', { headers: { 'x-orivon-node-features': 'bandwidth' } }) : Response.json(TRAFFIC)
    }) as unknown as typeof globalThis.fetch
    const read = bandwidthReader({ fetch, base: 'http://node.test', key: 'k' })
    expect(await read()).toBeNull()
    up = true
    expect(await read()).toEqual(TRAFFIC)
    expect(asked).toEqual(['/health', '/health', '/orivon/stats/bw'])
  })

  it('gives null for a route the node refuses or an answer that is not an object', async () => {
    expect(await node({ features: 'bandwidth', answer: () => new Response('no', { status: 400 }) }).read()).toBeNull()
    expect(await node({ features: 'bandwidth', answer: () => Response.json([1, 2]) }).read()).toBeNull()
    expect(await node({ features: 'bandwidth', answer: () => new Response('not json') }).read()).toBeNull()
  })

  it('keeps only numbers that are whole figures or rates, and leaves anything else null rather than zero', async () => {
    const answer = () => Response.json({ TotalIn: 7, TotalOut: '5', RateIn: -2, RateOut: 0.5, Extra: 1 })
    expect(await node({ features: 'bandwidth', answer }).read()).toEqual({ TotalIn: 7, TotalOut: null, RateIn: null, RateOut: 0.5 })
  })
})

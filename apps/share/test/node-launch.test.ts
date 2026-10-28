import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawned: Array<{ program: string, args: string[] }> = []

vi.mock('child_process', () => ({
  spawn: (program: string, args: string[]) => {
    spawned.push({ program, args })
    return Object.assign(new EventEmitter(), { stderr: new EventEmitter(), stdout: new EventEmitter(), kill: () => {} })
  }
}))

const KEY = 'ab'.repeat(32)

describe('starting the page\'s IPFS node', () => {
  beforeEach(() => {
    spawned.length = 0
    vi.stubGlobal('fetch', async (input: string) => /\/id$/.test(String(input)) && spawned.length > 0 ? Response.json({ peer: '12D3KooWpage' }) : Promise.reject(new TypeError('fetch failed')))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('asks the node to keep a place on Orivon\'s relay, with the relay named once in full', async () => {
    await import('../page/src/node/launch.js')
    const { shareNode } = globalThis as unknown as { shareNode: { start: (o: { key: string }) => Promise<{ base: string, peer: string, port: number }> } }
    const node = await shareNode.start({ key: KEY })
    expect(node).toMatchObject({ base: 'http://127.0.0.1:5200', peer: '12D3KooWpage', port: 5200 })
    expect(spawned).toHaveLength(1)
    const { program, args } = spawned[0]!
    expect(program).toBe('/bin/ipfs-node')
    const at = args.indexOf('--relay')
    expect(at).toBeGreaterThan(-1)
    expect(args.filter((arg) => arg === '--relay')).toHaveLength(1)
    const relay = args[at + 1]!
    expect(relay).toMatch(/^\/ip4\/\d+\.\d+\.\d+\.\d+\/tcp\/\d+\/p2p\/12D3KooW[1-9A-HJ-NP-Za-km-z]+$/)
    expect(args).toContain('--p2p-port')
    expect(args[args.indexOf('--p2p-port') + 1]).toBe('4801')
  })

  it('names the relay the app\'s own relay README says it announces', () => {
    const readme = readFileSync(new URL('../relay/README.md', import.meta.url), 'utf8')
    const launcher = readFileSync(new URL('../page/src/node/launch.js', import.meta.url), 'utf8')
    const announced = /Announces \| `(\/ip4\/[\d.]+\/tcp\/\d+)`/.exec(readme)?.[1]
    const relay = /const RELAY = '([^']+)'/.exec(launcher)?.[1]
    expect(announced).toBeDefined()
    expect(relay?.startsWith(`${announced}/p2p/`)).toBe(true)
  })

  it('gives every API port the launcher may use a p2p port orivon.json lets the node listen on', () => {
    const launcher = readFileSync(new URL('../page/src/node/launch.js', import.meta.url), 'utf8')
    const manifest = JSON.parse(readFileSync(new URL('../orivon.json', import.meta.url), 'utf8')) as { capabilities: { net: { tcp: { listen: { network: string[] } } } } }
    const constant = (name: string) => Number(new RegExp(`const ${name} = (\\d+)`).exec(launcher)?.[1])
    const [first, last] = manifest.capabilities.net.tcp.listen.network[0]!.split('-').map(Number) as [number, number]
    const lowest = constant('FIRST_P2P_PORT')
    const highest = lowest + constant('LAST_PORT') - constant('FIRST_PORT')
    expect(lowest).toBeGreaterThanOrEqual(first)
    expect(highest).toBeLessThanOrEqual(last)
  })
})

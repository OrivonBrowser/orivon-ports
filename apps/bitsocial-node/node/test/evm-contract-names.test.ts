// Where the evm-contract challenge reads an author's .eth or .bso name. The package resolves a name on Ethereum with its own client, whatever chain the board's
// contract is on: it reuses the board's `rpcUrls` only when they are for Ethereum, and otherwise its copy of viem's default server for Ethereum, which no option of
// the challenge changes. So a board on another chain reaches that server for every author name, unless the Worker answers that server's address itself (`ensRoute`,
// installed only where the browser has a light client).
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFetchHook } from '../kubo/index.js'
import { ALL, registerChallenges } from '../worker/challenges.js'
import { createEthereumReads, ensRoute, ETHEREUM_ORIGIN, LIGHT_CLIENT_CODE, VIEM_MAINNET_URL } from '../worker/ethereum-reads.js'

const NODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const EVM = '@bitsocial/evm-contract-challenge'
const OWN = 'https://rpc.own.example/eth'
const BASE_SERVER = 'https://rpc.base.example/key'

/** The universal resolver the challenge's copy of viem asks for Ethereum names, read from that copy. */
async function viemOfChallenge () {
  const fromChallenge = createRequire(join(NODE_DIR, 'node_modules', '@bitsocial', 'evm-contract-challenge', 'dist', 'index.js'))
  const chains = await import(/* @vite-ignore */ pathToFileURL(fromChallenge.resolve('viem/chains')).href) as { mainnet?: any, default?: { mainnet: any } }
  const mainnet = chains.mainnet ?? chains.default?.mainnet
  return { url: mainnet.rpcUrls.default.http[0] as string, resolver: String(mainnet.contracts.ensUniversalResolver.address).toLowerCase() }
}

/** Every request the process makes, with what the first of a JSON-RPC call named. */
type Seen = { url: string, method: string, to?: string }

let seen: Seen[] = []
let originalFetch: typeof fetch
/** A fetch that answers every JSON-RPC call with an empty result, so a name lookup ends at once and nothing reaches a network. */
const network = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  const sent = JSON.parse(String(init?.body ?? '{}')) as { id: unknown, method: string, params?: Array<{ to?: string }> }
  seen.push({ url, method: sent.method, ...(sent.params?.[0]?.to === undefined ? {} : { to: sent.params[0].to.toLowerCase() }) })
  return Response.json({ jsonrpc: '2.0', id: sent.id, result: '0x' })
}) as typeof fetch

beforeEach(() => { seen = []; originalFetch = globalThis.fetch; globalThis.fetch = network })
afterEach(() => { globalThis.fetch = originalFetch })

/** The challenge as the Worker registers it, run for an author whose address is a name and who has no wallet on the board's chain, so the name is what is read. */
async function check (options: Record<string, string>, ethereumUrl?: string) {
  const registry: Record<string, any> = {}
  registerChallenges(registry, ALL, ethereumUrl === undefined ? {} : { ethereumUrl })
  const publication = { author: { address: 'alice.eth' }, signature: { publicKey: 'key' } }
  return await registry[EVM]({ challengeSettings: {} }).getChallenge({
    challengeSettings: { options: { address: `0x${'ab'.repeat(20)}`, abi: '{"constant":true,"inputs":[{"name":"a","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"type":"function"}', condition: '>0', ...options } },
    challengeRequestMessage: { comment: publication },
    community: { _pkc: {} }
  })
}

const names = (to: string) => seen.filter((one) => one.to === to)

describe('where the evm-contract challenge reads an author name today', () => {
  it('reads it from the server its own viem names for Ethereum, for a board on another chain, whether or not the owner named that chain\'s servers', async () => {
    const { url, resolver } = await viemOfChallenge()
    await check({ chainTicker: 'base' })
    expect(names(resolver).map((one) => one.url)).toEqual([url])
    seen = []
    await check({ chainTicker: 'base', rpcUrls: BASE_SERVER })
    expect(names(resolver).map((one) => one.url)).toEqual([url])
  })

  it('is the address the Worker answers: the one its own viem names for Ethereum, read from that copy, so an update of the package that changes it fails here', async () => {
    expect((await viemOfChallenge()).url).toBe(VIEM_MAINNET_URL)
    expect(ALL.find((one) => one.name === EVM)?.hosts).toEqual([new URL(VIEM_MAINNET_URL).hostname])
  })

  it('reads it from the servers the owner named when the board is on Ethereum', async () => {
    const { resolver } = await viemOfChallenge()
    await check({ chainTicker: 'eth', rpcUrls: OWN })
    expect(names(resolver).map((one) => one.url)).toEqual([OWN])
  })
})

/** A handle of `ETH_NET_0_1_READONLY` that answers every `call` with the same bytes. */
function lightClient () {
  const calls: Array<{ to: string }> = []
  const handle = { code: LIGHT_CLIENT_CODE, blockNumber: async () => 19_000_000, call: vi.fn(async (call: { to: string }) => { calls.push(call); return { data: new Uint8Array(0), revert: null, offchainLookup: null } }) }
  return { handle, calls }
}

/** The Worker's side, as `run.js` sets it up: the route for the server viem names and the endpoint for the node's own address, over the stand-in network. */
function routed (reads: ReturnType<typeof createEthereumReads>, fallback: string[] = ['https://public.example']) {
  const endpoint = reads.endpoint(fallback)
  const undoHook = installFetchHook(globalThis, ETHEREUM_ORIGIN, endpoint)
  const undoRoute = installFetchHook(globalThis, VIEM_MAINNET_URL, ensRoute(endpoint))
  return () => { undoRoute(); undoHook() }
}

describe('where it reads it once the Worker answers that server\'s address from the browser\'s light client', () => {
  it('reads it through the light client, for a board on another chain, and the server viem names is not reached', async () => {
    const { resolver } = await viemOfChallenge()
    const light = lightClient()
    const publicServers = vi.fn(network)
    const reads = createEthereumReads({ orivon: { use: async () => light.handle }, fetch: publicServers })
    const undo = routed(reads)
    try {
      await check({ chainTicker: 'base' }, ETHEREUM_ORIGIN)
      await check({ chainTicker: 'base', rpcUrls: BASE_SERVER }, ETHEREUM_ORIGIN)
    } finally { undo() }
    expect(light.calls.filter((call) => call.to.toLowerCase() === resolver)).toHaveLength(2)
    expect(seen.filter((one) => one.url.includes('reth.rs'))).toEqual([])
    expect(publicServers).not.toHaveBeenCalled()
    expect(reads.status()).toMatchObject({ path: 'light-client', public: 0 })
  })

  it('reads the owner\'s own servers as they are named, for a board on Ethereum, and does not put the light client in front of them', async () => {
    const { resolver } = await viemOfChallenge()
    const light = lightClient()
    const reads = createEthereumReads({ orivon: { use: async () => light.handle }, fetch: network })
    const undo = routed(reads)
    try { await check({ chainTicker: 'eth', rpcUrls: OWN }, ETHEREUM_ORIGIN) } finally { undo() }
    expect(names(resolver).map((one) => one.url)).toEqual([OWN])
    expect(light.calls).toEqual([])
  })

  it('reads a board on Ethereum with no servers named through the light client, as it did, with one request for the name and no request to the server viem names', async () => {
    const { resolver } = await viemOfChallenge()
    const light = lightClient()
    const reads = createEthereumReads({ orivon: { use: async () => light.handle }, fetch: network })
    const undo = routed(reads)
    try { await check({ chainTicker: 'eth' }, ETHEREUM_ORIGIN) } finally { undo() }
    expect(light.calls.filter((call) => call.to.toLowerCase() === resolver)).toHaveLength(1)
    expect(seen.filter((one) => one.url.includes('reth.rs'))).toEqual([])
  })

  it('asks the public servers a read the light client cannot answer, as the board\'s own Ethereum reads do, and still not the server viem names', async () => {
    const { resolver } = await viemOfChallenge()
    const publicServers = vi.fn(network)
    const reads = createEthereumReads({ orivon: { use: async () => null }, fetch: publicServers, offMs: 60_000 })
    const undo = routed(reads, ['https://public.example'])
    try { await check({ chainTicker: 'base' }, ETHEREUM_ORIGIN) } finally { undo() }
    expect(names(resolver).map((one) => one.url)).toEqual(['https://public.example'])
    expect(seen.filter((one) => one.url.includes('reth.rs'))).toEqual([])
  })
})

describe('the route for the server viem names', () => {
  const post = (method: string, params: unknown[] = []) => globalThis.fetch(VIEM_MAINNET_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })

  it('answers a read and nothing else: a transaction, a signature or a method nobody asked for is refused, and no server hears of it', async () => {
    const light = lightClient()
    const publicServers = vi.fn(network)
    const reads = createEthereumReads({ orivon: { use: async () => light.handle }, fetch: publicServers })
    const undo = routed(reads)
    try {
      expect(((await (await post('eth_blockNumber')).json()) as any).result).toBe('0x121eac0')
      for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign', 'eth_signTransaction', 'debug_traceCall', 'eth_subscribe']) {
        expect(((await (await post(method, ['0x00'])).json()) as any).error.code, method).toBe(-32601)
      }
    } finally { undo() }
    expect(seen).toEqual([])
    expect(publicServers).not.toHaveBeenCalled()
  })

  it('answers only the path the server serves, and only a POST: anything else of that address gets a refusal and never reaches the network', async () => {
    const reads = createEthereumReads({ orivon: { use: async () => lightClient().handle }, fetch: network })
    const undo = routed(reads)
    try {
      const get = await globalThis.fetch(VIEM_MAINNET_URL)
      expect(get.status).toBe(405)
      const other = await globalThis.fetch(new URL('/other', VIEM_MAINNET_URL), { method: 'POST', body: '{}' })
      expect(other.status).toBe(404)
    } finally { undo() }
    expect(seen).toEqual([])
  })

  it('leaves every other address alone', async () => {
    const reads = createEthereumReads({ orivon: { use: async () => lightClient().handle }, fetch: network })
    const undo = routed(reads)
    try { await globalThis.fetch('https://rpc.own.example/eth', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'eth_sendRawTransaction', params: [] }) }) } finally { undo() }
    expect(seen.map((one) => one.url)).toEqual(['https://rpc.own.example/eth'])
  })

  it('is no route at all when it is not installed (a browser with no light client): the address is reached as it was', async () => {
    await post('eth_blockNumber')
    expect(seen.map((one) => one.url)).toEqual([VIEM_MAINNET_URL])
  })
})

// How the node reads Ethereum: through the browser's light client (`orivon.use('ETH_NET_0_1_READONLY')`) when the browser has one and the person allowed it, and
// from the public servers the desktop clients use when it has not or a read through it fails. The reads reach viem as JSON-RPC over `fetch` (the Worker answers
// them in the process, with no socket), so what is proven here is the detection, the shape of every answer, the order of the two paths, and that a write is never made.
import { createPublicClient, encodeAbiParameters, http, parseAbi } from 'viem'
import { mainnet } from 'viem/chains'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFetchHook } from '../kubo/index.js'
import { ETHEREUM_ORIGIN, LIGHT_CLIENT_CODE, canUseLightClient, createEthereumReads, planOf } from '../worker/ethereum-reads.js'

const ADDRESS = '0x00000000000000000000000000000000000000c7'
const PUBLIC = ['https://one.example', 'https://two.example']
const hex = (value: Uint8Array): string => `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
const bytesOf = (...values: number[]): Uint8Array => Uint8Array.from(values)

/** A handle of `ETH_NET_0_1_READONLY` that answers from a table of what each function gives; every function is a mock the test reads. */
function lightClient (answers: Record<string, unknown> = {}) {
  const handle: Record<string, any> = { code: LIGHT_CLIENT_CODE }
  const defaults: Record<string, unknown> = {
    chainId: 1, blockNumber: 19_000_000, getBalance: '0xde0b6b3a7640000', getTransactionCount: 5, getCode: bytesOf(0x60, 0x01), getStorageAt: new Uint8Array(32),
    call: { data: bytesOf(0, 0, 7), revert: null, offchainLookup: null }, estimateGas: 21_000, gasPrice: '0x3b9aca00', maxPriorityFeePerGas: '0x59682f00'
  }
  for (const [name, value] of Object.entries({ ...defaults, ...answers })) handle[name] = vi.fn(async (..._args: unknown[]) => (typeof value === 'function' ? await (value as (...a: unknown[]) => unknown)(..._args) : value))
  return handle
}

/** A fetch for the public servers: `answers` maps a provider origin to what it says (a JSON-RPC result, `{ error }`, an HTTP status or a thrown failure). */
function publicServers (answers: Record<string, unknown>) {
  const asked: Array<{ url: string, method: string }> = []
  const served = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const body = JSON.parse(String(init?.body ?? '{}')) as { id: unknown, method: string }
    asked.push({ url, method: body.method })
    const answer = answers[url]
    if (answer instanceof Error) throw answer
    if (typeof answer === 'number') return new Response('no', { status: answer })
    const object = (answer ?? { result: '0x01' }) as Record<string, unknown>
    return Response.json({ jsonrpc: '2.0', id: body.id, ...object })
  }) as unknown as typeof fetch & { mock: { calls: unknown[][] } }
  return { fetch: served, asked }
}

const rpc = (method: string, params: unknown[] = [], id: number | string = 1): string => JSON.stringify({ jsonrpc: '2.0', id, method, params })

async function ask (reads: ReturnType<typeof createEthereumReads>, body: string, fallback: string[] = PUBLIC): Promise<any> {
  const answer = await reads.endpoint(fallback).handle(new Request(ETHEREUM_ORIGIN, { method: 'POST', body, headers: { 'content-type': 'application/json' } }))
  return await answer.json()
}

function setup (options: { use?: (code: string) => Promise<any>, servers?: Record<string, unknown>, offMs?: number, lightMs?: number, publicMs?: number } = {}) {
  const servers = publicServers(options.servers ?? {})
  const lines: string[] = []
  const orivon = { use: options.use ?? vi.fn(async () => lightClient()) }
  const reads = createEthereumReads({ orivon, fetch: servers.fetch, now: () => Date.now(), warn: (line: string) => { lines.push(line) }, ...(options.offMs === undefined ? {} : { offMs: options.offMs }), ...(options.lightMs === undefined ? {} : { lightMs: options.lightMs }), ...(options.publicMs === undefined ? {} : { publicMs: options.publicMs }) })
  return { reads, orivon, servers, lines }
}

describe('whether this browser offers a light client to an app', () => {
  it('is true for a browser whose `orivon.use` is a function, and false for one that has none (v0.1.0 answers a namespace there) or no `orivon` at all', () => {
    expect(canUseLightClient({ use: async () => null })).toBe(true)
    expect(canUseLightClient({ use: new Proxy({}, { get: () => async () => null }) })).toBe(false)
    expect(canUseLightClient({})).toBe(false)
    expect(canUseLightClient(undefined)).toBe(false)
    expect(canUseLightClient(null)).toBe(false)
  })
})

describe('how a JSON-RPC read becomes a call on the light client', () => {
  it('maps the ten reads the node makes, with bytes as bytes, integers as integers and quantities as the strings the standard spells', () => {
    expect(planOf('eth_chainId', [])).toEqual({ fn: 'chainId', args: [], shape: 'quantity' })
    expect(planOf('eth_blockNumber', [])).toEqual({ fn: 'blockNumber', args: [], shape: 'quantity' })
    expect(planOf('eth_getBalance', [ADDRESS, 'latest'])).toEqual({ fn: 'getBalance', args: [ADDRESS, 'latest'], shape: 'text' })
    expect(planOf('eth_getBalance', [ADDRESS])).toEqual({ fn: 'getBalance', args: [ADDRESS], shape: 'text' })
    expect(planOf('eth_getTransactionCount', [ADDRESS, '0x10'])).toEqual({ fn: 'getTransactionCount', args: [ADDRESS, '0x10'], shape: 'quantity' })
    expect(planOf('eth_getCode', [ADDRESS, 'latest'])).toEqual({ fn: 'getCode', args: [ADDRESS, 'latest'], shape: 'bytes' })
    expect(planOf('eth_getStorageAt', [ADDRESS, '0x0', 'latest'])).toEqual({ fn: 'getStorageAt', args: [ADDRESS, '0x0', 'latest'], shape: 'bytes' })
    expect(planOf('eth_gasPrice', [])).toEqual({ fn: 'gasPrice', args: [], shape: 'text' })
    expect(planOf('eth_maxPriorityFeePerGas', [])).toEqual({ fn: 'maxPriorityFeePerGas', args: [], shape: 'text' })
    expect(planOf('eth_call', [{ to: ADDRESS, data: '0x70a08231', gas: '0x5208', nonce: '0x1', value: '0x0' }, 'latest'])).toEqual({
      fn: 'call', args: [{ to: ADDRESS, data: bytesOf(0x70, 0xa0, 0x82, 0x31), gas: 21_000, nonce: 1, value: '0x0' }, 'latest'], shape: 'call'
    })
    expect(planOf('eth_estimateGas', [{ to: ADDRESS, input: '0x01' }])).toEqual({ fn: 'estimateGas', args: [{ to: ADDRESS, data: bytesOf(1) }], shape: 'quantity' })
  })

  it('reads a block as a tag, a number or a hash: pending is latest, earliest is block 0, and an EIP-1898 object names a number or a hash', () => {
    const hash = `0x${'ab'.repeat(32)}`
    expect(planOf('eth_getBalance', [ADDRESS, 'pending'])?.args[1]).toBe('latest')
    expect(planOf('eth_getBalance', [ADDRESS, 'earliest'])?.args[1]).toBe('0x0')
    expect(planOf('eth_getBalance', [ADDRESS, 'finalized'])?.args[1]).toBe('finalized')
    expect(planOf('eth_getBalance', [ADDRESS, { blockNumber: '0x5' }])?.args[1]).toBe('0x5')
    expect(planOf('eth_getBalance', [ADDRESS, { blockHash: hash }])?.args[1]).toBe(hash)
  })

  it('leaves to the public servers what the module does not carry or the node never asks: other methods, a block object that names two things, fields the module has no name for, a state override', () => {
    for (const method of ['eth_getLogs', 'eth_feeHistory', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getProof', 'eth_syncing', 'net_version']) expect(planOf(method, []), method).toBeNull()
    expect(planOf('eth_getBalance', [ADDRESS, { blockNumber: '0x1', blockHash: `0x${'ab'.repeat(32)}` }])).toBeNull()
    expect(planOf('eth_getBalance', [ADDRESS, 'someday'])).toBeNull()
    expect(planOf('eth_call', [{ to: ADDRESS, chainId: '0x1' }, 'latest'])).toBeNull()
    expect(planOf('eth_call', [{ to: ADDRESS, type: '0x2' }, 'latest'])).toBeNull()
    expect(planOf('eth_call', [{ to: ADDRESS, accessList: [] }, 'latest'])).toBeNull()
    expect(planOf('eth_call', [{ to: ADDRESS }, 'latest', { [ADDRESS]: { balance: '0x1' } }])).toBeNull()
    expect(planOf('eth_call', [{ to: ADDRESS, data: '0xzz' }, 'latest'])).toBeNull()
    expect(planOf('eth_call', [{ to: ADDRESS, value: '0x01' }, 'latest'])).toBeNull()
    expect(planOf('eth_call', ['not an object'])).toBeNull()
    expect(planOf('eth_getBalance', ['not an address'])).toBeNull()
  })
})

describe('a read when the browser has a light client', () => {
  it('is answered by the light client alone, and the public servers are not asked', async () => {
    const { reads, orivon, servers } = setup()
    expect(await ask(reads, rpc('eth_blockNumber'))).toEqual({ jsonrpc: '2.0', id: 1, result: '0x121eac0' })
    expect(orivon.use).toHaveBeenCalledWith(LIGHT_CLIENT_CODE)
    expect(servers.asked).toEqual([])
    expect(reads.status()).toMatchObject({ path: 'light-client', lightClient: 1, public: 0 })
  })

  it('turns every answer into what a node says: quantities as hexadecimal, bytes as hexadecimal, a call as its data', async () => {
    const { reads } = setup()
    expect((await ask(reads, rpc('eth_chainId'))).result).toBe('0x1')
    expect((await ask(reads, rpc('eth_getBalance', [ADDRESS, 'latest']))).result).toBe('0xde0b6b3a7640000')
    expect((await ask(reads, rpc('eth_getTransactionCount', [ADDRESS]))).result).toBe('0x5')
    expect((await ask(reads, rpc('eth_getCode', [ADDRESS]))).result).toBe('0x6001')
    expect((await ask(reads, rpc('eth_getStorageAt', [ADDRESS, '0x0']))).result).toBe(`0x${'00'.repeat(32)}`)
    expect((await ask(reads, rpc('eth_call', [{ to: ADDRESS, data: '0x01' }, 'latest']))).result).toBe('0x000007')
    expect((await ask(reads, rpc('eth_estimateGas', [{ to: ADDRESS }]))).result).toBe('0x5208')
    expect((await ask(reads, rpc('eth_gasPrice'))).result).toBe('0x3b9aca00')
  })

  it('hands the light client the call as the standard takes it: the data as bytes, the block as asked, nothing that follows or stops an offchain lookup', async () => {
    const handle = lightClient()
    const { reads } = setup({ use: vi.fn(async () => handle) })
    await ask(reads, rpc('eth_call', [{ to: ADDRESS, data: '0x70a08231' }, 'latest']))
    expect(handle['call']).toHaveBeenCalledWith({ to: ADDRESS, data: bytesOf(0x70, 0xa0, 0x82, 0x31) }, 'latest')
  })

  it('answers a revert as a node does, error 3 with the return data a library decodes the reason from, and does not ask the public servers about it', async () => {
    const reason = bytesOf(0x08, 0xc3, 0x79, 0xa0)
    const { reads, servers } = setup({ use: vi.fn(async () => lightClient({ call: { data: null, revert: reason, offchainLookup: null } })) })
    const answer = await ask(reads, rpc('eth_call', [{ to: ADDRESS, data: '0x01' }, 'latest']))
    expect(answer.error).toEqual({ code: 3, message: 'execution reverted', data: hex(reason) })
    expect(servers.asked).toEqual([])
  })

  it('answers a batch in order, each with its own id, some by the light client and the rest by the public servers', async () => {
    const { reads, servers } = setup()
    const answers = await ask(reads, JSON.stringify([
      { jsonrpc: '2.0', id: 'a', method: 'eth_blockNumber', params: [] },
      { jsonrpc: '2.0', id: 'b', method: 'eth_getLogs', params: [{}] },
      { jsonrpc: '2.0', id: 'c', method: 'eth_chainId', params: [] }
    ]))
    expect(answers.map((one: any) => one.id)).toEqual(['a', 'b', 'c'])
    expect(answers.map((one: any) => one.result)).toEqual(['0x121eac0', '0x01', '0x1'])
    expect(servers.asked).toEqual([{ url: PUBLIC[0], method: 'eth_getLogs' }])
  })

  it('asks the browser for the code once, and for no more than eight reads at the same time', async () => {
    let running = 0
    let peak = 0
    const slow = vi.fn(async () => { running += 1; peak = Math.max(peak, running); await new Promise((resolve) => setTimeout(resolve, 10)); running -= 1; return 7 })
    const use = vi.fn(async () => lightClient({ blockNumber: slow }))
    const { reads } = setup({ use })
    const answers = await Promise.all(Array.from({ length: 20 }, async (_, at) => await ask(reads, rpc('eth_blockNumber', [], at))))
    expect(answers.every((one) => one.result === '0x7')).toBe(true)
    expect(use).toHaveBeenCalledTimes(1)
    expect(peak).toBeLessThanOrEqual(8)
  })
})

describe('a read when the light client cannot answer', () => {
  it('goes to the public servers when the browser gives no handle (the person said Not now, or nothing in the browser answers the code), says why, and asks the browser again only after a while', async () => {
    vi.useFakeTimers()
    try {
      const use = vi.fn(async () => null)
      const { reads, servers } = setup({ use, offMs: 30_000 })
      expect((await ask(reads, rpc('eth_blockNumber'))).result).toBe('0x01')
      expect(servers.asked).toEqual([{ url: PUBLIC[0], method: 'eth_blockNumber' }])
      expect(reads.status()).toMatchObject({ path: 'public', why: 'no-handle', lightClient: 0, public: 1 })
      await ask(reads, rpc('eth_blockNumber'))
      expect(use).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(30_001)
      await ask(reads, rpc('eth_blockNumber'))
      expect(use).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('goes to the public servers when the browser refuses the question, whatever the code of the refusal', async () => {
    for (const code of ['denied', 'closed', 'limit', 'unavailable']) {
      const { reads, servers } = setup({ use: vi.fn(async () => { throw Object.assign(new Error(code), { code }) }) })
      expect((await ask(reads, rpc('eth_chainId'))).result, code).toBe('0x01')
      expect(servers.asked.length, code).toBe(1)
      expect(reads.status().why, code).toBe(code)
    }
  })

  it('says in a line a bug report carries why the light client is not used: the code of the refusal and its words, and that no handle came', async () => {
    const refused = setup({ use: vi.fn(async () => { throw Object.assign(new Error('the person answered Not now'), { code: 'denied' }) }) })
    await ask(refused.reads, rpc('eth_chainId'))
    expect(refused.lines.join('\n')).toMatch(/light client is not used: denied \(the person answered Not now\)/)
    const none = setup({ use: vi.fn(async () => null) })
    await ask(none.reads, rpc('eth_chainId'))
    expect(none.lines.join('\n')).toMatch(/light client is not used: no-handle/)
    await ask(none.reads, rpc('eth_chainId'))
    expect(none.lines.filter((line) => /light client is not used/.test(line))).toHaveLength(1)
  })

  it('says in a line a bug report carries which read the light client failed and why, with no address or value in it', async () => {
    const handle = lightClient({ call: async () => { throw Object.assign(new Error('the client is syncing'), { code: 'unavailable' }) } })
    const { reads, lines } = setup({ use: vi.fn(async () => handle) })
    await ask(reads, rpc('eth_call', [{ to: ADDRESS, data: '0x70a08231' }, 'latest']))
    expect(lines.join('\n')).toMatch(/ethereum: the light client failed eth_call: unavailable \(the client is syncing\)/)
    expect(lines.join('\n')).not.toContain(ADDRESS)
  })

  it('does not take a handle that cannot answer a block number for a light client', async () => {
    const { reads, servers } = setup({ use: vi.fn(async () => lightClient({ blockNumber: async () => { throw Object.assign(new Error('starting'), { code: 'unavailable' }) } })) })
    expect((await ask(reads, rpc('eth_gasPrice'))).result).toBe('0x01')
    expect(servers.asked).toHaveLength(1)
    expect(reads.status()).toMatchObject({ path: 'public', why: 'unavailable' })
  })

  it('goes to the public servers for one read that fails, and after two failures in a row stops asking the light client for a while, then tries it again', async () => {
    vi.useFakeTimers()
    try {
      let working = false
      const handle = lightClient({ getBalance: async () => { if (!working) throw Object.assign(new Error('gone'), { code: 'unavailable' }); return '0x1' } })
      const use = vi.fn(async () => handle)
      const { reads, servers } = setup({ use, offMs: 30_000 })
      await ask(reads, rpc('eth_getBalance', [ADDRESS]))
      await ask(reads, rpc('eth_getBalance', [ADDRESS]))
      expect(handle['getBalance']).toHaveBeenCalledTimes(2)
      expect(servers.asked).toHaveLength(2)
      await ask(reads, rpc('eth_getBalance', [ADDRESS]))
      expect(handle['getBalance']).toHaveBeenCalledTimes(2)
      expect(servers.asked).toHaveLength(3)
      expect(reads.status()).toMatchObject({ path: 'public', why: 'unavailable' })
      working = true
      vi.advanceTimersByTime(30_001)
      expect((await ask(reads, rpc('eth_getBalance', [ADDRESS]))).result).toBe('0x1')
      expect(use).toHaveBeenCalledTimes(2)
      expect(reads.status().path).toBe('light-client')
    } finally { vi.useRealTimers() }
  })

  it('reads a call with no `to` (the deployless call viem makes to check a signature) from the public servers when the light client cannot answer it, and does not count it against the light client', async () => {
    const handle = lightClient({ call: async (transaction: { to?: string }) => { if (transaction.to === undefined) throw Object.assign(new Error('no provider'), { code: 'unavailable' }); return { data: bytesOf(0, 0, 7), revert: null, offchainLookup: null } } })
    const { reads, servers, lines } = setup({ use: vi.fn(async () => handle) })
    const deployless = rpc('eth_call', [{ data: '0x6080' }, 'latest'])
    for (let time = 0; time < 3; time += 1) expect((await ask(reads, deployless)).result).toBe('0x01')
    expect(servers.asked).toHaveLength(3)
    expect(lines.join('\n')).toMatch(/light client failed eth_call: unavailable/)
    expect(lines.join('\n')).not.toMatch(/light client is not used/)
    expect((await ask(reads, rpc('eth_call', [{ to: ADDRESS, data: '0x01' }, 'latest']))).result).toBe(hex(bytesOf(0, 0, 7)))
    expect(servers.asked).toHaveLength(3)
    expect(reads.status().path).toBe('light-client')
  })

  it('reads a call the standard refuses as invalid from the public servers, and says so in a line a bug report carries, with no address in it', async () => {
    const handle = lightClient({ call: async () => { throw Object.assign(new Error('bad shape'), { code: 'invalid' }) } })
    const { reads, servers, lines } = setup({ use: vi.fn(async () => handle) })
    expect((await ask(reads, rpc('eth_call', [{ to: ADDRESS, data: '0x01' }, 'latest']))).result).toBe('0x01')
    expect(servers.asked).toHaveLength(1)
    expect(lines.join('\n')).toMatch(/light client refused eth_call as invalid/)
    expect(lines.join('\n')).not.toContain(ADDRESS)
    expect(reads.status().path).toBe('light-client')
  })

  it('reads from the public servers what the light client does not carry, while it stays the path of everything else', async () => {
    const { reads, servers } = setup()
    expect((await ask(reads, rpc('eth_getLogs', [{ fromBlock: '0x1' }]))).result).toBe('0x01')
    expect(servers.asked).toEqual([{ url: PUBLIC[0], method: 'eth_getLogs' }])
    expect((await ask(reads, rpc('eth_chainId'))).result).toBe('0x1')
  })

  it('does not wait for a question the person has not answered: after the budget the read goes to the public servers, and the answer, when it comes, makes the light client the path', async () => {
    vi.useFakeTimers()
    try {
      let answer: (handle: unknown) => void = () => {}
      const use = vi.fn(() => new Promise((resolve) => { answer = resolve }))
      const { reads, servers } = setup({ use, lightMs: 8_000 })
      const first = ask(reads, rpc('eth_chainId'))
      await vi.advanceTimersByTimeAsync(8_001)
      expect((await first).result).toBe('0x01')
      expect(servers.asked).toHaveLength(1)
      expect(reads.status()).toMatchObject({ path: 'asking' })
      expect(use).toHaveBeenCalledTimes(1)
      answer(lightClient())
      await vi.advanceTimersByTimeAsync(10)
      expect((await ask(reads, rpc('eth_chainId'))).result).toBe('0x1')
      expect(use).toHaveBeenCalledTimes(1)
      expect(reads.status().path).toBe('light-client')
    } finally { vi.useRealTimers() }
  })

  it('does not wait for a light client that does not answer a read: after the budget the read goes to the public servers', async () => {
    vi.useFakeTimers()
    try {
      const { reads, servers } = setup({ use: vi.fn(async () => lightClient({ getBalance: () => new Promise(() => {}) })), lightMs: 8_000 })
      const slow = ask(reads, rpc('eth_getBalance', [ADDRESS]))
      await vi.advanceTimersByTimeAsync(8_001)
      expect((await slow).result).toBe('0x01')
      expect(servers.asked).toEqual([{ url: PUBLIC[0], method: 'eth_getBalance' }])
      const again = ask(reads, rpc('eth_getBalance', [ADDRESS]))
      await vi.advanceTimersByTimeAsync(8_001)
      await again
      expect(reads.status()).toMatchObject({ path: 'public', why: 'timeout' })
    } finally { vi.useRealTimers() }
  })
})

describe('the public servers', () => {
  it('are asked in order, and the next is asked when one fails, answers with an error status or answers with a server error', async () => {
    const { reads, servers } = setup({ use: vi.fn(async () => null), servers: { [PUBLIC[0] as string]: new Error('down'), [PUBLIC[1] as string]: { result: '0x2a' } } })
    expect((await ask(reads, rpc('eth_blockNumber'))).result).toBe('0x2a')
    expect(servers.asked.map((one) => one.url)).toEqual(PUBLIC)

    const second = setup({ use: vi.fn(async () => null), servers: { [PUBLIC[0] as string]: 503, [PUBLIC[1] as string]: { result: '0x2b' } } })
    expect((await ask(second.reads, rpc('eth_blockNumber'))).result).toBe('0x2b')

    const third = setup({ use: vi.fn(async () => null), servers: { [PUBLIC[0] as string]: { error: { code: -32005, message: 'rate limited' } }, [PUBLIC[1] as string]: { result: '0x2c' } } })
    expect((await ask(third.reads, rpc('eth_blockNumber'))).result).toBe('0x2c')
  })

  it('give a revert as the answer it is, and the next server is not asked', async () => {
    const reverted = { error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } }
    const { reads, servers } = setup({ use: vi.fn(async () => null), servers: { [PUBLIC[0] as string]: reverted } })
    expect((await ask(reads, rpc('eth_call', [{ to: ADDRESS }, 'latest']))).error).toEqual(reverted.error)
    expect(servers.asked).toHaveLength(1)
  })

  it('answer the error of the last server when none answers', async () => {
    const { reads } = setup({ use: vi.fn(async () => null), servers: { [PUBLIC[0] as string]: new Error('down'), [PUBLIC[1] as string]: 500 } })
    const answer = await ask(reads, rpc('eth_blockNumber'))
    expect(answer.error.code).toBe(-32603)
    expect(answer.error.message).toMatch(/no Ethereum server answered/)
    expect(JSON.stringify(answer)).not.toContain('example')
  })

  it('are whichever the endpoint was given: the node\'s own six, or the servers of a test, and none at all for a run that must reach no public chain', async () => {
    const { reads, servers } = setup({ use: vi.fn(async () => null) })
    await ask(reads, rpc('eth_blockNumber'), [PUBLIC[1] as string])
    expect(servers.asked.map((one) => one.url)).toEqual([PUBLIC[1]])
    const none = await ask(reads, rpc('eth_blockNumber'), [])
    expect(none.error.code).toBe(-32603)
    expect(servers.asked).toHaveLength(1)
  })

  it('are given a limit of time each, so a server that never answers does not hold the read', async () => {
    vi.useFakeTimers()
    try {
      const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
        if (String(input) === PUBLIC[1]) { resolve(Response.json({ jsonrpc: '2.0', id: 1, result: '0x2d' })); return }
        init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason) })
      })) as unknown as typeof globalThis.fetch
      const reads = createEthereumReads({ orivon: { use: async () => null }, fetch, publicMs: 5_000 })
      const slow = ask(reads, rpc('eth_blockNumber'))
      await vi.advanceTimersByTimeAsync(5_001)
      expect((await slow).result).toBe('0x2d')
    } finally { vi.useRealTimers() }
  })
})

describe('what is never read through either path', () => {
  it('refuses every method that signs or sends, answers method not found, and reaches neither the light client nor a public server', async () => {
    const { reads, orivon, servers } = setup()
    for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData_v4', 'eth_signTransaction', 'wallet_sendCalls', 'eth_accounts', 'eth_requestAccounts', 'eth_subscribe']) {
      const answer = await ask(reads, rpc(method, ['0x00']))
      expect(answer.error?.code, method).toBe(-32601)
      expect(answer.result, method).toBeUndefined()
    }
    expect(orivon.use).not.toHaveBeenCalled()
    expect(servers.asked).toEqual([])
  })

  it('answers a request it cannot read with the JSON-RPC error for it, and a method other than POST with 405', async () => {
    const { reads } = setup()
    const endpoint = reads.endpoint(PUBLIC)
    const bad = await endpoint.handle(new Request(ETHEREUM_ORIGIN, { method: 'POST', body: '{nope' }))
    expect(((await bad.json()) as any).error.code).toBe(-32700)
    const notRequest = await endpoint.handle(new Request(ETHEREUM_ORIGIN, { method: 'POST', body: '{"id":1}' }))
    expect(((await notRequest.json()) as any).error.code).toBe(-32600)
    expect((await endpoint.handle(new Request(ETHEREUM_ORIGIN, { method: 'GET' }))).status).toBe(405)
    const tooMany = await endpoint.handle(new Request(ETHEREUM_ORIGIN, { method: 'POST', body: JSON.stringify(Array.from({ length: 101 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'eth_chainId' }))) }))
    expect(((await tooMany.json()) as any).error.code).toBe(-32600)
  })
})

describe('what the dashboard is told', () => {
  it('says which path read last, and counts the reads of each', async () => {
    const { reads } = setup({ use: vi.fn(async () => null) })
    expect(reads.status()).toEqual({ path: 'public', why: 'not-asked', lightClient: 0, public: 0 })
    await ask(reads, rpc('eth_chainId'))
    expect(reads.status()).toEqual({ path: 'public', why: 'no-handle', lightClient: 0, public: 1 })
  })

  it('starts the browser\'s question when the dashboard asks and no read has, so the person is asked when the dashboard is opened and not only at the first name', async () => {
    const use = vi.fn(async () => lightClient())
    const { reads } = setup({ use })
    reads.look()
    await vi.waitFor(() => { expect(reads.status().path).toBe('light-client') })
    expect(use).toHaveBeenCalledTimes(1)
  })
})

describe('through viem, as pkc-js\'s name resolvers and the evm-contract challenge read', () => {
  const ERC20 = parseAbi(['function balanceOf(address account) view returns (uint256)'])
  let restore: (() => void) | null = null
  beforeEach(() => { restore = null })
  afterEach(() => { restore?.() })

  /** `globalThis`-like scope with the hook installed for both origins, as `run.js` does. */
  function hooked (reads: ReturnType<typeof createEthereumReads>, fallback: string[] = PUBLIC) {
    const scope = { fetch: (async () => { throw new TypeError('nothing outside the hook should be reached') }) as typeof fetch }
    restore = installFetchHook(scope, ETHEREUM_ORIGIN, reads.endpoint(fallback))
    const previous = globalThis.fetch
    globalThis.fetch = scope.fetch
    const undo = restore
    restore = () => { undo(); globalThis.fetch = previous }
    return scope
  }

  it('reads a contract through the light client: viem\'s `readContract` becomes one `call` on the handle', async () => {
    const answer = encodeAbiParameters([{ type: 'uint256' }], [1_234n])
    const handle = lightClient({ call: { data: Uint8Array.from(Buffer.from(answer.slice(2), 'hex')), revert: null, offchainLookup: null } })
    const { reads, servers } = setup({ use: vi.fn(async () => handle) })
    hooked(reads)
    const client = createPublicClient({ chain: mainnet, transport: http(ETHEREUM_ORIGIN, { retryCount: 0 }) })
    expect(await client.readContract({ address: ADDRESS, abi: ERC20, functionName: 'balanceOf', args: [ADDRESS] })).toBe(1_234n)
    expect(handle['call']).toHaveBeenCalledTimes(1)
    expect(servers.asked).toEqual([])
  })

  it('reads from the public server when the browser has no light client, as it was read before', async () => {
    const answer = encodeAbiParameters([{ type: 'uint256' }], [5n])
    const { reads, servers } = setup({ use: vi.fn(async () => null), servers: { [PUBLIC[0] as string]: { result: answer } } })
    hooked(reads)
    const client = createPublicClient({ chain: mainnet, transport: http(ETHEREUM_ORIGIN, { retryCount: 0 }) })
    expect(await client.readContract({ address: ADDRESS, abi: ERC20, functionName: 'balanceOf', args: [ADDRESS] })).toBe(5n)
    expect(servers.asked).toEqual([{ url: PUBLIC[0], method: 'eth_call' }])
  })

  it('shows a revert to viem as the revert it is', async () => {
    const handle = lightClient({ call: { data: null, revert: Uint8Array.from([0x08, 0xc3, 0x79, 0xa0]), offchainLookup: null } })
    const { reads } = setup({ use: vi.fn(async () => handle) })
    hooked(reads)
    const client = createPublicClient({ chain: mainnet, transport: http(ETHEREUM_ORIGIN, { retryCount: 0 }) })
    await expect(client.readContract({ address: ADDRESS, abi: ERC20, functionName: 'balanceOf', args: [ADDRESS] })).rejects.toThrow(/reverted|revert/i)
  })
})

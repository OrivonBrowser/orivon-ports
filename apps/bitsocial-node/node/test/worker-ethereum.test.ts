// How the Worker reads Ethereum: the one name resolver and the two in-process addresses on a browser with a light client, the six public servers
// as they were on one without, and the path the name calls report. The reads themselves are in `ethereum-reads.test.ts`.
import { describe, expect, it, vi } from 'vitest'
import { startWorker } from '../worker/run.js'
import { ETH_RPC_URLS } from '../worker/eth-providers.js'
import { ETHEREUM_ORIGIN, LIGHT_CLIENT_CODE, VIEM_MAINNET_URL } from '../worker/ethereum-reads.js'
import { ALL } from '../worker/challenges.js'
import { KEY, setup, useWorkerFolder } from './support/worker-harness.ts'

useWorkerFolder()

describe('how the Worker reads Ethereum', () => {
  const rpcBody = (method: string, params: unknown[] = []) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  const post = async (run: Awaited<ReturnType<typeof setup>>, origin: string, method: string, params: unknown[] = []) => await (await run.scope.fetch(origin, { method: 'POST', headers: { 'content-type': 'application/json' }, body: rpcBody(method, params) })).json() as Record<string, any>
  const resolversOf = (run: Awaited<ReturnType<typeof setup>>) => (run.pkc.options!['pkcOptions'] as Record<string, any>)['nameResolvers'] as Array<{ provider: string, key: string }>
  /** A browser with a light client whose block number is `head`. */
  const browser = (head = 19_000_000) => ({ use: vi.fn(async (code: string) => ({ code, blockNumber: async () => head, getBalance: async () => '0x1' })) })
  const nameCall = (run: Awaited<ReturnType<typeof setup>>, call: string) => fetch(`http://127.0.0.1:${String(run.config.ports.gateway)}/orivon/name/${call}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, body: '{}' })

  it('gives pkc-js one name resolver that reads through the browser\'s light client, in a browser that offers one, and answers its reads in the process', async () => {
    const run = await setup()
    const orivon = browser()
    Object.assign(run.environment, { orivon })
    await startWorker(run.environment as never)
    expect(resolversOf(run).map((one) => [one.key, one.provider])).toEqual([['eth-orivon', ETHEREUM_ORIGIN]])
    expect(await post(run, ETHEREUM_ORIGIN, 'eth_blockNumber')).toEqual({ jsonrpc: '2.0', id: 1, result: '0x121eac0' })
    expect(orivon.use).toHaveBeenCalledWith(LIGHT_CLIENT_CODE)
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('keeps the desktop\'s six public servers as they were in a browser with no such function (v0.1.0), and puts no hook in front of its address', async () => {
    const run = await setup()
    Object.assign(run.environment, { orivon: { use: new Proxy({}, { get: () => async () => null }) } })
    await startWorker(run.environment as never)
    expect(resolversOf(run).map((one) => one.provider)).toEqual(ETH_RPC_URLS)
    await expect(run.scope.fetch(ETHEREUM_ORIGIN, { method: 'POST', body: rpcBody('eth_blockNumber') })).rejects.toThrow(/fetch failed/)
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('reads the public servers a test names when the light client cannot answer', async () => {
    const run = await setup()
    const asked: string[] = []
    Object.assign(run.environment, { orivon: { use: async () => null }, ethRpcUrls: ['http://127.0.0.1:18545'], fetch: async (input: string) => { asked.push(String(input)); return Response.json({ jsonrpc: '2.0', id: 1, result: '0x2' }) } })
    await startWorker(run.environment as never)
    expect((await post(run, ETHEREUM_ORIGIN, 'eth_blockNumber')).result).toBe('0x2')
    expect(asked.filter((url) => !url.includes(String(run.config.ports.nodeApi)))).toEqual(['http://127.0.0.1:18545'])
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('reaches no public server at all when the environment says so (BITSOCIAL_ETH_PUBLIC=off, for a run that must touch no public chain), with or without a light client', async () => {
    const run = await setup()
    const asked: string[] = []
    Object.assign(run.environment, { orivon: { use: async () => null }, fetch: async (input: string) => { asked.push(String(input)); return Response.json({ jsonrpc: '2.0', id: 1, result: '0x2' }) } })
    run.environment.env = { ...run.environment.env, BITSOCIAL_ETH_PUBLIC: 'off' }
    await startWorker(run.environment as never)
    expect((await post(run, ETHEREUM_ORIGIN, 'eth_blockNumber')).error.code).toBe(-32603)
    expect(asked.filter((url) => !url.includes(String(run.config.ports.nodeApi)))).toEqual([])
    await run.handlers[0]!({ cmd: 'stop' })

    const plain = await setup()
    plain.environment.env = { ...plain.environment.env, BITSOCIAL_ETH_PUBLIC: 'off' }
    await startWorker(plain.environment as never)
    expect(resolversOf(plain)).toEqual([])
    await plain.handlers[0]!({ cmd: 'stop' })
  })

  it('answers the server the evm-contract challenge\'s own viem names for Ethereum from the same endpoint, in a browser with a light client and in no other', async () => {
    const run = await setup()
    const orivon = browser()
    const asked: string[] = []
    Object.assign(run.environment, { orivon, fetch: async (input: string) => { asked.push(String(input)); return Response.json({ jsonrpc: '2.0', id: 1, result: '0x2' }) } })
    await startWorker(run.environment as never)
    expect(await post(run, VIEM_MAINNET_URL, 'eth_blockNumber')).toEqual({ jsonrpc: '2.0', id: 1, result: '0x121eac0' })
    expect((await post(run, VIEM_MAINNET_URL, 'eth_sendRawTransaction', ['0x00'])).error.code).toBe(-32601)
    expect(asked.filter((url) => !url.includes(String(run.config.ports.nodeApi)))).toEqual([])
    await run.handlers[0]!({ cmd: 'stop' })
    // Stopping puts the address back as it was: nothing answers it any more.
    await vi.waitFor(async () => { await expect(run.scope.fetch(VIEM_MAINNET_URL, { method: 'POST', body: rpcBody('eth_blockNumber') })).rejects.toThrow(/fetch failed/) })

    const older = await setup()
    Object.assign(older.environment, { orivon: { use: new Proxy({}, { get: () => async () => null }) } })
    await startWorker(older.environment as never)
    await expect(older.scope.fetch(VIEM_MAINNET_URL, { method: 'POST', body: rpcBody('eth_blockNumber') })).rejects.toThrow(/fetch failed/)
    await older.handlers[0]!({ cmd: 'stop' })

    const isolated = await setup()
    isolated.environment.env = { BITSOCIAL_NODE: JSON.stringify({ ...isolated.config, isolated: { bootstrap: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWRelayRelay'] } }) }
    Object.assign(isolated.environment, { orivon: browser() })
    await startWorker(isolated.environment as never)
    await expect(isolated.scope.fetch(VIEM_MAINNET_URL, { method: 'POST', body: rpcBody('eth_blockNumber') })).rejects.toThrow(/fetch failed/)
    await isolated.handlers[0]!({ cmd: 'stop' })
  })

  it('reads nothing of Ethereum in a run with no internet, whatever the browser offers', async () => {
    const run = await setup()
    const orivon = browser()
    Object.assign(run.environment, { orivon })
    run.environment.env = { BITSOCIAL_NODE: JSON.stringify({ ...run.config, isolated: { bootstrap: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWRelayRelay'] } }) }
    await startWorker(run.environment as never)
    expect(resolversOf(run)).toEqual([])
    await expect(run.scope.fetch(ETHEREUM_ORIGIN, { method: 'POST', body: rpcBody('eth_blockNumber') })).rejects.toThrow(/fetch failed/)
    expect(orivon.use).not.toHaveBeenCalled()
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('tells the name calls which path reads Ethereum, and asks the browser when they first ask', async () => {
    const run = await setup({ communities: [{ address: '12D3KooWJoFVU6rBeqCTZoPszCaWyENY5ahrTUsNpHqhfrpmwkZD', started: true }] })
    const orivon = browser()
    Object.assign(run.environment, { orivon })
    await startWorker(run.environment as never)
    expect(orivon.use).not.toHaveBeenCalled()
    const first = await (await nameCall(run, 'boards')).json() as Record<string, any>
    expect(first['ethereum'].path).toBe('asking')
    await vi.waitFor(async () => { expect(((await (await nameCall(run, 'boards')).json()) as Record<string, any>)['ethereum']).toEqual({ path: 'light-client', lightClient: 0, public: 0 }) })
    expect(orivon.use).toHaveBeenCalledTimes(1)
    await run.handlers[0]!({ cmd: 'stop' })

    const isolated = await setup({ communities: [{ address: '12D3KooWJoFVU6rBeqCTZoPszCaWyENY5ahrTUsNpHqhfrpmwkZD', started: true }] })
    isolated.environment.env = { BITSOCIAL_NODE: JSON.stringify({ ...isolated.config, isolated: { bootstrap: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWRelayRelay'] } }) }
    await startWorker(isolated.environment as never)
    expect(((await (await nameCall(isolated, 'boards')).json()) as Record<string, any>)['ethereum']).toEqual({ path: 'none' })
    await isolated.handlers[0]!({ cmd: 'stop' })
  })

  it('tells the challenges call which path reads Ethereum as the name calls do, so the dashboard names the host a challenge that reads Ethereum reaches', async () => {
    const challengeBoards = async (run: Awaited<ReturnType<typeof setup>>) => await (await fetch(`http://127.0.0.1:${String(run.config.ports.gateway)}/orivon/challenges/boards`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, body: '{}' })).json() as Record<string, any>

    const light = await setup()
    const orivon = browser()
    Object.assign(light.environment, { orivon, challenges: { registry: {} } })
    await startWorker(light.environment as never)
    expect(orivon.use).not.toHaveBeenCalled()
    expect((await challengeBoards(light))['ethereum'].path).toBe('asking')
    await vi.waitFor(async () => { expect((await challengeBoards(light))['ethereum']).toEqual({ path: 'light-client', lightClient: 0, public: 0 }) })
    expect(orivon.use).toHaveBeenCalledTimes(1)
    await light.handlers[0]!({ cmd: 'stop' })

    const older = await setup()
    Object.assign(older.environment, { orivon: { use: new Proxy({}, { get: () => async () => null }) }, challenges: { registry: {} } })
    await startWorker(older.environment as never)
    expect((await challengeBoards(older))['ethereum']).toEqual({ path: 'public', why: 'unsupported' })
    await older.handlers[0]!({ cmd: 'stop' })

    const isolated = await setup()
    isolated.environment.env = { BITSOCIAL_NODE: JSON.stringify({ ...isolated.config, isolated: { bootstrap: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWRelayRelay'] } }) }
    Object.assign(isolated.environment, { orivon: browser(), challenges: { registry: {} } })
    await startWorker(isolated.environment as never)
    expect((await challengeBoards(isolated))['ethereum']).toEqual({ path: 'none' })
    await isolated.handlers[0]!({ cmd: 'stop' })
  })
})

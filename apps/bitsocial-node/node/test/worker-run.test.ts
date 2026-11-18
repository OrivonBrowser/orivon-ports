// The Worker's whole life against stand-ins for the node and for pkc-js's server: the order it starts in, the key at the
// RPC's door, the gateway that serves no RPC, what a failure at each stage tells the page, and how a stop undoes it.
import { EventEmitter } from 'node:events'
import * as realFs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { startWorker } from '../worker/run.js'
import { ETH_RPC_URLS } from '../worker/eth-providers.js'
import { KEY, opens, setup, useWorkerFolder } from './support/worker-harness.ts'

useWorkerFolder()

describe('startWorker', () => {
  it('starts the node, then opens the RPC, and tells the page ready only after the port is listening', async () => {
    const run = await setup({ rpcDelayMs: 60 })
    await startWorker(run.environment as never)
    const { events } = run
    const spawned = events.findIndex((event) => event.startsWith('spawn '))
    const rpcListening = events.findIndex((event) => event === `listening ${String(run.config.ports.rpc)}`)
    expect(spawned).toBeGreaterThan(-1)
    expect(rpcListening).toBeGreaterThan(spawned)
    expect(rpcListening).toBeLessThan(events.indexOf('send ready'))
    expect(run.sent.filter((message) => message['type'] === 'node').map((message) => message['state'])).toEqual(['starting', 'up'])
    expect(run.sent.at(-1)).toEqual({ type: 'ready', ports: { rpc: run.config.ports.rpc, gateway: run.config.ports.gateway } })
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('opens pkc-js\'s server with the desktop\'s options, on the facade\'s kubo origin and under the app\'s files', async () => {
    const run = await setup()
    await startWorker(run.environment as never)
    const options = run.pkc.options!['pkcOptions'] as Record<string, any>
    expect(options['dataPath']).toBe(`${run.config.files}/pkc`)
    expect(options['kuboRpcClientsOptions']).toEqual([{ url: `http://127.0.0.1:${String(run.config.ports.kubo)}/api/v0` }])
    expect(options['httpRoutersOptions']).toHaveLength(4)
    expect(options['nameResolvers']).toHaveLength(6)
    expect(run.pkc.options!['authKey']).toBe(KEY)
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('asks the name resolvers of a test\'s own providers when the test names them, and the desktop\'s six otherwise', async () => {
    const run = await setup()
    Object.assign(run.environment, { ethRpcUrls: ['http://127.0.0.1:18545'] })
    await startWorker(run.environment as never)
    const resolvers = (run.pkc.options!['pkcOptions'] as Record<string, any>)['nameResolvers'] as Array<{ provider: string, key: string }>
    expect(resolvers.map((one) => one.provider)).toEqual(['http://127.0.0.1:18545'])
    expect(resolvers[0]!.key).toBe('eth-127.0.0.1')
    await run.handlers[0]!({ cmd: 'stop' })
    const plain = await setup()
    await startWorker(plain.environment as never)
    expect(((plain.pkc.options!['pkcOptions'] as Record<string, any>)['nameResolvers'] as Array<{ provider: string }>).map((one) => one.provider)).toEqual(ETH_RPC_URLS)
    await plain.handlers[0]!({ cmd: 'stop' })
  })

  it('never takes the providers from the page\'s configuration: a key of that name in it changes nothing', async () => {
    const run = await setup()
    run.environment.env = { BITSOCIAL_NODE: JSON.stringify({ ...run.config, ethRpcUrls: ['http://evil.example'] }) }
    await startWorker(run.environment as never)
    expect(((run.pkc.options!['pkcOptions'] as Record<string, any>)['nameResolvers'] as Array<{ provider: string }>).map((one) => one.provider)).toEqual(ETH_RPC_URLS)
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('lets only the path of the key through the RPC door, though pkc-js would admit any loopback client', async () => {
    const run = await setup()
    await startWorker(run.environment as never)
    const port = run.config.ports.rpc
    expect(await opens(port, `/${KEY}`)).toBe(true)
    expect(await opens(port, '/')).toBe(false)
    expect(await opens(port, '/wrong-key')).toBe(false)
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('answers pkc-js\'s kubo calls in the process, and serves the gateway on a socket without the RPC', async () => {
    const run = await setup()
    await startWorker(run.environment as never)
    const inProcess = await run.scope.fetch(`http://127.0.0.1:${String(run.config.ports.kubo)}/api/v0/version`, { method: 'POST' })
    expect(inProcess.status).toBe(200)
    const onSocket = await fetch(`http://127.0.0.1:${String(run.config.ports.gateway)}/api/v0/version`, { method: 'POST' })
    expect(onSocket.status).toBe(404)
    const media = await fetch(`http://127.0.0.1:${String(run.config.ports.gateway)}/ipfs/bafkreihmqln2iovmfzti2f6s7yjlr5l54stgzsadfxndh7diovlbzgucye`)
    expect(media.status).toBeGreaterThanOrEqual(400)
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('writes the start and the end of the facade\'s record calls only when BITSOCIAL_FACADE_TRACE is 1', async () => {
    const quiet = await setup()
    await startWorker(quiet.environment as never)
    await quiet.scope.fetch(`http://127.0.0.1:${String(quiet.config.ports.kubo)}/api/v0/name/resolve?arg=k51qzi5uqu5dgzzzzzzz`, { method: 'POST' })
    expect(quiet.lines.filter((line) => /^(facade|node) (call|done|fetch) /.test(line))).toEqual([])
    await quiet.handlers[0]!({ cmd: 'stop' })
    const traced = await setup()
    ;(traced.environment.env as Record<string, string>)['BITSOCIAL_FACADE_TRACE'] = '1'
    await startWorker(traced.environment as never)
    await traced.scope.fetch(`http://127.0.0.1:${String(traced.config.ports.kubo)}/api/v0/name/resolve?arg=k51qzi5uqu5dgzzzzzzz`, { method: 'POST' })
    const seen = traced.lines.filter((line) => /^facade (call|done) /.test(line))
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatch(/^facade call t=\d+ POST \/api\/v0\/name\/resolve\?arg=k51qzi5uqu5dgzzzzzzz$/)
    expect(seen[1]).toMatch(/^facade done t=\d+ POST \/api\/v0\/name\/resolve answered \d+ in \d+ ms$/)
    // the node's own API: the calls of the Worker that do not go through the node client are written too
    expect(traced.lines.filter((line) => /^node fetch done t=\d+ \w+ \/\S+ (\d+|failed) in \d+ ms/.test(line)).length).toBeGreaterThan(0)
    expect(traced.lines.filter((line) => /^node done t=\d+ \w+ \/\S+ /.test(line)).length).toBeGreaterThan(0)
    await traced.handlers[0]!({ cmd: 'stop' })
  })

  it('answers a page\'s read-only calls on the gateway\'s socket with the key, and nothing else', async () => {
    const run = await setup()
    await startWorker(run.environment as never)
    const call = (path: string, key: string | null = KEY) => fetch(`http://127.0.0.1:${String(run.config.ports.gateway)}/orivon/api/${path}`, { method: 'POST', headers: key === null ? {} : { Authorization: `Bearer ${key}` } })
    expect(await (await call('swarm/addrs/autonat')).json()).toEqual({ reachability: 'Unknown' })
    expect(await (await call('stats/bw')).json()).toEqual({ TotalIn: null, TotalOut: null, RateIn: null, RateOut: null })
    expect((await call('swarm/addrs/autonat', null)).status).toBe(401)
    expect((await call('swarm/addrs/autonat', 'wrong')).status).toBe(401)
    expect((await call('key/gen')).status).toBe(403)
    expect((await call('files/rm')).status).toBe(403)
    await run.handlers[0]!({ cmd: 'stop' })
  })

  describe('stats/bw', () => {
    const traffic = { TotalIn: 4096, TotalOut: 1024, RateIn: 12, RateOut: 0 }
    const bw = (run: Awaited<ReturnType<typeof setup>>) => fetch(`http://127.0.0.1:${String(run.config.ports.gateway)}/orivon/api/stats/bw`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } }).then((answer) => answer.json())

    it('passes the node\'s own numbers through when the node names the bandwidth feature, asking with the node\'s key', async () => {
      const run = await setup({ features: 'add,pin,car,serve,listen,bandwidth', bandwidth: traffic })
      await startWorker(run.environment as never)
      expect(await bw(run)).toEqual(traffic)
      expect(run.bandwidthAsked).toEqual(['f'.repeat(64)])
      await run.handlers[0]!({ cmd: 'stop' })
    })

    it('reads the numbers again at each call, so a page sees traffic grow', async () => {
      const run = await setup({ features: 'bandwidth', bandwidth: traffic })
      await startWorker(run.environment as never)
      await bw(run)
      await bw(run)
      expect(run.bandwidthAsked).toHaveLength(2)
      await run.handlers[0]!({ cmd: 'stop' })
    })

    it('answers the nulls, and never asks the route, for a node that does not name the feature', async () => {
      for (const features of [undefined, 'add,pin,car,serve,listen']) {
        const run = await setup({ ...(features === undefined ? {} : { features }), bandwidth: traffic })
        await startWorker(run.environment as never)
        expect(await bw(run)).toEqual({ TotalIn: null, TotalOut: null, RateIn: null, RateOut: null })
        expect(run.bandwidthAsked).toEqual([])
        await run.handlers[0]!({ cmd: 'stop' })
      }
    })

    it('answers the nulls when the node refuses the route, and a null for a number that is not one, never a zero', async () => {
      const refused = await setup({ features: 'bandwidth', bandwidth: 400 })
      await startWorker(refused.environment as never)
      expect(await bw(refused)).toEqual({ TotalIn: null, TotalOut: null, RateIn: null, RateOut: null })
      await refused.handlers[0]!({ cmd: 'stop' })
      const odd = await setup({ features: 'bandwidth', bandwidth: { TotalIn: 10, TotalOut: '5', RateIn: -1, RateOut: null } })
      await startWorker(odd.environment as never)
      expect(await bw(odd)).toEqual({ TotalIn: 10, TotalOut: null, RateIn: null, RateOut: null })
      await odd.handlers[0]!({ cmd: 'stop' })
    })
  })

  it('reports the node\'s status to the page, and again when asked', async () => {
    const run = await setup()
    await startWorker(run.environment as never)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(run.sent.find((message) => message['type'] === 'status')?.['status']).toMatchObject({ peer: '12D3KooWnode', reachability: 'unknown' })
    const before = run.sent.filter((message) => message['type'] === 'status').length
    run.handlers[0]!({ cmd: 'status' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(run.sent.filter((message) => message['type'] === 'status').length).toBe(before + 1)
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('starts a node that punches with the one port and the relay the person named, and has the page told the way in', async () => {
    const relay = '/ip4/145.40.68.4/tcp/4001/p2p/12D3KooWRelayRelay'
    const run = await setup({
      flags: ['--publish', '--key-secret', '--punch-port', '--relay'],
      relay,
      punch: { state: 'ready', relaysKnown: 9, relaysHeld: 2, punched: 1, failed: 0 },
      status: { reachability: 'unknown', relays: [`${relay}/p2p-circuit/p2p/12D3KooWnode`, '/ip4/203.0.113.9/tcp/4001/p2p/12D3KooWOther/p2p-circuit/p2p/12D3KooWnode'] }
    })
    await startWorker(run.environment as never)
    const args = run.spawned[0]!
    expect(args.slice(args.indexOf('--punch-port'), args.indexOf('--punch-port') + 2)).toEqual(['--punch-port', String(run.config.ports.p2p)])
    expect(args).not.toContain('--p2p-port')
    expect(args.slice(args.indexOf('--relay'), args.indexOf('--relay') + 2)).toEqual(['--relay', relay])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(run.sent.find((message) => message['type'] === 'status')?.['status']).toMatchObject({ reachability: 'public', basis: 'punched', autonat: 'unknown', relays: 2, punch: { state: 'ready', relaysHeld: 2, punched: 1 } })
    const call = await fetch(`http://127.0.0.1:${String(run.config.ports.gateway)}/orivon/api/swarm/addrs/autonat`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } })
    expect(await call.json()).toEqual({ reachability: 'Public' })
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('takes the way in from the node\'s reach: a punch that could work and has not been tried is not "reachable", in the page API, the status and the log line', async () => {
    const relay = '/ip4/145.40.68.4/tcp/4001/p2p/12D3KooWRelayRelay'
    const run = await setup({
      flags: ['--publish', '--key-secret', '--punch-port', '--relay'],
      relay,
      punch: { state: 'ready', relaysKnown: 9, relaysHeld: 2, punched: 0, failed: 0 },
      status: { reachability: 'unknown', relays: [`${relay}/p2p-circuit/p2p/12D3KooWnode`], reach: { state: 'unknown', reason: 'punch-ready' } }
    })
    await startWorker(run.environment as never)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(run.sent.find((message) => message['type'] === 'status')?.['status']).toMatchObject({ reachability: 'unknown', basis: 'punch-ready', source: 'node' })
    const call = await fetch(`http://127.0.0.1:${String(run.config.ports.gateway)}/orivon/api/swarm/addrs/autonat`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } })
    expect(await call.json()).toEqual({ reachability: 'Unknown' })
    expect(run.warnings.filter((line) => line.startsWith('reachability '))).toEqual(['reachability unknown (punch-ready: a punch can work and none has been tried): hole punch ready, 2 of 9 relays hold a place, 0 punched, 0 failed; AutoNAT unknown; 1 circuit addresses, 0 confirmed addresses'])
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('says, in the line, a reason of the node\'s that this Worker has no sentence for, by its word alone', async () => {
    const run = await setup({ status: { reachability: 'unknown', reach: { state: 'private', reason: 'quic-blocked' } } })
    await startWorker(run.environment as never)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(run.warnings.filter((line) => line.startsWith('reachability '))).toEqual(['reachability private (quic-blocked): no hole punch; AutoNAT unknown; 0 circuit addresses, 0 confirmed addresses'])
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('writes one line for the log a bug report carries when the way in changes: counts and states, no address, no peer', async () => {
    const relay = '/ip4/145.40.68.4/tcp/4001/p2p/12D3KooWRelayRelay'
    const run = await setup({
      flags: ['--publish', '--key-secret', '--punch-port'],
      punch: { state: 'symmetric-nat', relaysKnown: 7, relaysHeld: 2, punched: 0, failed: 3 },
      status: { reachability: 'private', relays: [`${relay}/p2p-circuit/p2p/12D3KooWnode`], external: [] }
    })
    await startWorker(run.environment as never)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const reported = run.warnings.filter((line) => line.startsWith('reachability '))
    expect(reported).toEqual(['reachability private (symmetric-nat, read by the Worker: the node gives no reach): hole punch symmetric-nat, 2 of 7 relays hold a place, 0 punched, 3 failed; AutoNAT private; 1 circuit addresses, 0 confirmed addresses'])
    expect(reported.join('')).not.toMatch(/198\.51|12D3Koo/)
    run.handlers[0]!({ cmd: 'status' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(run.warnings.filter((line) => line.startsWith('reachability '))).toHaveLength(1)
    expect(run.lines.filter((line) => line.startsWith('reachability '))).toEqual([])
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('hands the lines pkc-js\'s logger would write to the warnings a bug report carries', async () => {
    const run = await setup()
    await startWorker(run.environment as never)
    const hook = (run.scope as unknown as Record<string, (...parts: unknown[]) => void>)['__bitsocialPkcLog']!
    hook('2026-11-14T10:00:00.000Z pkc-js-rpc:pkc-ws-server:auto-start Auto-starting 1 communities', { count: 1 })
    expect(run.warnings.at(-1)).toBe('pkc-js 2026-11-14T10:00:00.000Z pkc-js-rpc:pkc-ws-server:auto-start Auto-starting 1 communities {"count":1}')
    expect(run.lines.join('\n')).not.toMatch(/Auto-starting/)
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('says failed at the node stage, and opens nothing, when the node never answers', async () => {
    const run = await setup({ nodeAnswers: false })
    await startWorker(run.environment as never)
    expect(run.sent.at(-1)).toMatchObject({ type: 'failed', stage: 'node' })
    expect(run.exits).toEqual([1])
    expect(run.pkc.options).toBeNull()
  })

  it('removes the lock directories a killed node left before it starts one, and none while a node answers', async () => {
    const gone = await setup({ nodeGone: true })
    await startWorker(gone.environment as never)
    expect(gone.removed).toEqual(['node/blocks.db.lock', 'node/keys.db.lock'])
    expect(gone.events.indexOf('remove keys.db.lock')).toBeLessThan(gone.events.findIndex((event) => event.startsWith('spawn ')))
    await gone.handlers[0]!({ cmd: 'stop' })

    const answering = await setup()
    await startWorker(answering.environment as never)
    expect(answering.removed).toEqual([])
    await answering.handlers[0]!({ cmd: 'stop' })
  })

  it('asks again when the origin\'s call limit refuses the RPC server, and gives up after five tries', async () => {
    const again = await setup({ limitRefusals: 2 })
    await startWorker(again.environment as never)
    expect(again.sent.at(-1)).toEqual({ type: 'ready', ports: { rpc: again.config.ports.rpc, gateway: again.config.ports.gateway } })
    const giveUp = await setup({ limitRefusals: 5 })
    await startWorker(giveUp.environment as never)
    expect(giveUp.sent.at(-1)).toMatchObject({ type: 'failed', stage: 'rpc', code: 'limit' })
    expect(giveUp.exits).toEqual([1])
  })

  it('says failed at the rpc stage, with the code, when the RPC port is taken, and ends the node', async () => {
    const run = await setup({ occupy: 'rpc' })
    await startWorker(run.environment as never)
    expect(run.sent.at(-1)).toMatchObject({ type: 'failed', stage: 'rpc', code: 'EADDRINUSE' })
    expect(run.exits).toEqual([1])
    expect(run.pkc.destroyed).toBe(true)
    expect(run.children[0]!.killed).toBe(true)
    await run.stopBlocker()
  })

  it('goes on without the gateway when its port is taken, and says so', async () => {
    const run = await setup({ occupy: 'gateway' })
    await startWorker(run.environment as never)
    expect(run.sent.find((message) => message['type'] === 'error')).toMatchObject({ where: 'gateway', code: 'EADDRINUSE' })
    expect(run.sent.at(-1)).toEqual({ type: 'ready', ports: { rpc: run.config.ports.rpc, gateway: null } })
    await run.handlers[0]!({ cmd: 'stop' })
    await run.stopBlocker()
  })

  it('makes the key secret once, seals the node\'s keys under it, and reads the same one at the next start', async () => {
    const flags = ['--publish', '--key-secret']
    const first = await setup({ flags })
    await startWorker(first.environment as never)
    const path = `${first.config.files}/node/keys.secret`
    expect(first.files.get(path)).toBe(`${'f'.repeat(64)}\n`)
    expect(first.spawned[0]).toContain('--key-secret')
    expect(first.spawned[0]![first.spawned[0]!.indexOf('--key-secret') + 1]).toBe('f'.repeat(64))
    await first.handlers[0]!({ cmd: 'stop' })

    const again = await setup({ flags })
    again.files.set(`${again.config.files}/node/keys.secret`, `${'a'.repeat(64)}\n`)
    await startWorker(again.environment as never)
    expect(again.spawned[0]![again.spawned[0]!.indexOf('--key-secret') + 1]).toBe('a'.repeat(64))
    await again.handlers[0]!({ cmd: 'stop' })
  })

  it('says failed at the keys stage, and starts nothing, when the secret file holds something else', async () => {
    const run = await setup({ flags: ['--publish', '--key-secret'] })
    run.files.set(`${run.config.files}/node/keys.secret`, 'not a secret\n')
    await startWorker(run.environment as never)
    expect(run.sent.at(-1)).toMatchObject({ type: 'failed', stage: 'keys' })
    expect(run.spawned).toEqual([])
    expect(run.exits).toEqual([1])
  })

  it('tells the page when the node\'s keys are sealed under another secret, and goes on', async () => {
    const run = await setup({ flags: ['--publish', '--key-secret'], publishing: 'locked' })
    await startWorker(run.environment as never)
    expect(run.sent.find((message) => message['type'] === 'error')).toMatchObject({ where: 'keys', code: 'keys-locked' })
    expect(run.sent.at(-1)).toMatchObject({ type: 'ready' })
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('undoes everything on stop: the RPC, the gateway, the fetch hook and the node', async () => {
    const run = await setup()
    await startWorker(run.environment as never)
    const hooked = run.scope.fetch
    expect(hooked).not.toBe(run.originalFetch)
    run.handlers[0]!({ cmd: 'stop' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(run.exits).toEqual([0])
    expect(run.pkc.destroyed).toBe(true)
    expect(run.children[0]!.killed).toBe(true)
    expect(run.scope.fetch).toBe(run.originalFetch)
    expect(await opens(run.config.ports.rpc, `/${KEY}`)).toBe(false)
    await expect(fetch(`http://127.0.0.1:${String(run.config.ports.gateway)}/`)).rejects.toThrow()
  })
})

describe('the board manager', () => {
  const managerCall = (run: Awaited<ReturnType<typeof setup>>, call: string, body: unknown = {}, key: string | null = KEY) => fetch(`http://127.0.0.1:${String(run.config.ports.gateway)}/orivon/manager/${call}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key === null ? {} : { Authorization: `Bearer ${key}` }) }, body: JSON.stringify(body) })

  function withManager (run: Awaited<ReturnType<typeof setup>>) {
    const started: Array<Record<string, any>> = []
    const stopped: string[] = []
    Object.assign(run.environment, {
      fs: realFs,
      boardManager: {
        startBoardManager: async (options: Record<string, any>) => { started.push(options); run.events.push('manager started'); return { stop: async () => { stopped.push(String(options['communityAddress'])); run.pkc.order.push('manager stopped') } } },
        resolveBoardManagerOptions: (board: Record<string, any>, _config: unknown, directory: string) => ({ communityAddress: board['address'], boardDir: `${directory}/boards/${String(board['address'])}`, ...(board['perPage'] === undefined ? {} : { perPage: board['perPage'] }) })
      }
    })
    return { started, stopped }
  }

  const keep = (run: Awaited<ReturnType<typeof setup>>, address: string, config: Record<string, unknown> = {}) => {
    const folder = `${run.config.files}/board-manager/boards/${address}`
    realFs.mkdirSync(folder, { recursive: true })
    realFs.writeFileSync(`${folder}/config.json`, JSON.stringify({ address, ...config }))
  }

  it('starts the managers of the boards that are on once the RPC is listening, against the Worker\'s own RPC with the key, and tells the page ready without waiting for them', async () => {
    const run = await setup({ communities: [{ address: 'a.bso', started: true }] })
    const { started } = withManager(run)
    keep(run, 'a.bso', { perPage: 3 })
    keep(run, 'off.bso', { enabled: false })
    await startWorker(run.environment as never)
    await vi.waitFor(() => { expect(started).toHaveLength(1) })
    expect(started[0]).toMatchObject({ communityAddress: 'a.bso', perPage: 3, pkcRpcUrl: `ws://127.0.0.1:${String(run.config.ports.rpc)}/${KEY}` })
    expect(run.events.indexOf('manager started')).toBeGreaterThan(run.events.indexOf(`listening ${String(run.config.ports.rpc)}`))
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('stops the managers before it closes the RPC they are connected to', async () => {
    const run = await setup({ communities: [{ address: 'a.bso' }] })
    const { started, stopped } = withManager(run)
    keep(run, 'a.bso')
    await startWorker(run.environment as never)
    await vi.waitFor(() => { expect(started).toHaveLength(1) })
    run.handlers[0]!({ cmd: 'stop' })
    await vi.waitFor(() => { expect(run.exits).toEqual([0]) })
    expect(stopped).toEqual(['a.bso'])
    expect(run.pkc.order).toEqual(['manager stopped', 'rpc destroyed'])
  })

  it('lists and turns on a board over the gateway\'s socket with the key, and refuses the rest of the world', async () => {
    const run = await setup({ communities: [{ address: 'a.bso', started: true }, { address: 'free.bso', started: true }] })
    const { started } = withManager(run)
    keep(run, 'a.bso')
    await startWorker(run.environment as never)
    const listed = await (await managerCall(run, 'boards')).json() as { boards: Array<{ address: string, managed: boolean }> }
    expect(listed.boards.map((board) => [board.address, board.managed])).toEqual([['a.bso', true], ['free.bso', false]])
    expect((await managerCall(run, 'enable', { address: 'free.bso' })).status).toBe(200)
    await vi.waitFor(() => { expect(started.map((options) => options['communityAddress']).sort()).toEqual(['a.bso', 'free.bso']) })
    expect(JSON.parse(realFs.readFileSync(`${run.config.files}/board-manager/boards/free.bso/config.json`, 'utf-8'))).toEqual({ address: 'free.bso' })
    expect((await managerCall(run, 'boards', {}, null)).status).toBe(401)
    expect((await managerCall(run, 'boards', {}, 'wrong')).status).toBe(401)
    expect((await managerCall(run, 'forget', { address: 'a.bso' })).status).toBe(403)
    expect((await managerCall(run, 'enable', { address: 'nobody.bso' })).status).toBe(404)
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('says in each board\'s view whether its community sets features.noArchive: true, false, or not known for a board that is not running', async () => {
    const run = await setup({
      communities: [{ address: 'plain.bso', started: true }, { address: 'bare.bso', started: true }, { address: 'idle.bso' }],
      startedCommunities: { 'plain.bso': { features: { noUpvotes: true } }, 'bare.bso': { features: { noArchive: true } } }
    })
    withManager(run)
    await startWorker(run.environment as never)
    const listed = await (await managerCall(run, 'boards')).json() as { boards: Array<{ address: string, noArchive: boolean | null }> }
    expect(listed.boards.map((board) => [board.address, board.noArchive])).toEqual([['bare.bso', true], ['idle.bso', null], ['plain.bso', false]])
    expect(await (await managerCall(run, 'board', { address: 'bare.bso' })).json()).toMatchObject({ address: 'bare.bso', noArchive: true })
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('writes what the managers say as warnings, with the key left out, so a bug report carries it', async () => {
    const run = await setup({ communities: [{ address: 'a.bso' }] })
    withManager(run)
    keep(run, 'a.bso')
    await startWorker(run.environment as never)
    await vi.waitFor(() => { expect(run.warnings.some((line) => /board manager a\.bso: running/.test(line))).toBe(true) })
    const route = (run.scope as Record<string, any>)['__bitsocialBoardLog']
    route('error', 'bitsocial:5chan-board-manager', [`failed to reach ws://127.0.0.1:1/${KEY}`])
    expect(run.warnings.at(-1)).toBe('board manager error: failed to reach ws://127.0.0.1:1/<key>')
    expect(run.warnings.join('\n')).not.toContain(KEY)
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('answers 503 for the control calls when the build has no board manager, and starts nothing', async () => {
    const run = await setup()
    await startWorker(run.environment as never)
    expect((await managerCall(run, 'boards')).status).toBe(503)
    expect((await managerCall(run, 'boards', {}, null)).status).toBe(401)
    await run.handlers[0]!({ cmd: 'stop' })
  })
})

describe('the challenges', () => {
  const challengeCall = (run: Awaited<ReturnType<typeof setup>>, call: string, key: string | null = KEY) => fetch(`http://127.0.0.1:${String(run.config.ports.gateway)}/orivon/challenges/${call}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key === null ? {} : { Authorization: `Bearer ${key}` }) }, body: '{}' })
  const NAMES = ['@bitsocial/base64-challenge', '@bitsocial/wordfilter-challenge', '@orivon/id-challenge']

  /** A registry shaped as pkc-js's, and the names it holds when the RPC server is created. */
  function withChallenges (run: Awaited<ReturnType<typeof setup>>) {
    const registry: Record<string, unknown> = { 'text-math': () => ({ description: 'math', type: 'text/plain', optionInputs: [] }) }
    const seen: { atRpcStart: string[] } = { atRpcStart: [] }
    const server = run.environment.PKCRpc.PKCWsServer
    run.environment.PKCRpc.PKCWsServer = async (given: Record<string, any>) => { seen.atRpcStart = Object.keys(registry); return server(given) }
    Object.assign(run.environment, { challenges: { registry } })
    return { registry, seen }
  }

  it('registers the bundled challenges in pkc-js\'s registry before its server is created, so a community that starts at boot finds them', async () => {
    const run = await setup()
    const { registry, seen } = withChallenges(run)
    await startWorker(run.environment as never)
    expect(seen.atRpcStart).toEqual(expect.arrayContaining([...NAMES, 'text-math']))
    expect(typeof registry['@bitsocial/wordfilter-challenge']).toBe('function')
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('answers the list to the page with the key, with each challenge\'s option schema, and 401 without it', async () => {
    const run = await setup()
    withChallenges(run)
    await startWorker(run.environment as never)
    const answer = await (await challengeCall(run, 'list')).json() as { challenges: Array<{ name: string, source: string, optionInputs: unknown[] }>, unavailable: Array<{ name: string }> }
    expect(answer.challenges.map((one) => one.name)).toEqual(expect.arrayContaining(['text-math', ...NAMES]))
    expect(answer.challenges.find((one) => one.name === '@bitsocial/wordfilter-challenge')).toMatchObject({ source: 'bundled', optionInputs: expect.any(Array) })
    expect(answer.unavailable.map((one) => one.name)).toEqual(['@bitsocial/mintpass-challenge'])
    expect((await challengeCall(run, 'list', null)).status).toBe(401)
    expect((await challengeCall(run, 'install')).status).toBe(403)
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('answers 503 for the list when the build has no challenges', async () => {
    const run = await setup()
    await startWorker(run.environment as never)
    expect((await challengeCall(run, 'list')).status).toBe(503)
    expect((await challengeCall(run, 'list', null)).status).toBe(401)
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('writes what the challenge packages log as warnings, with the key left out, so a bug report carries it', async () => {
    const run = await setup()
    await startWorker(run.environment as never)
    const route = (run.scope as unknown as Record<string, (...args: unknown[]) => void>)['__bitsocialChallengeLog']!
    route('log', '@bitsocial/spam-blocker-challenge', ['scored a publication'])
    route('error', '@bitsocial/flags-challenge', [`failed to reach https://h/${KEY}`])
    expect(run.warnings.slice(-2)).toEqual(['challenge: scored a publication', 'challenge error: failed to reach https://h/<key>'])
    await run.handlers[0]!({ cmd: 'stop' })
  })
})

describe('a board\'s challenges, edited by the page', () => {
  const call = (run: Awaited<ReturnType<typeof setup>>, name: string, body: Record<string, unknown> = {}, key: string | null = KEY) => fetch(`http://127.0.0.1:${String(run.config.ports.gateway)}/orivon/challenges/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key === null ? {} : { Authorization: `Bearer ${key}` }) }, body: JSON.stringify(body) })
  const WORD = { name: '@bitsocial/wordfilter-challenge', options: { 'wordfilter/v1/rules': '[]' } }
  const BASE64 = { name: '@bitsocial/base64-challenge' }
  const COMMUNITIES = [{ address: 'idle.bso', name: 'idle.bso', publicKey: '12D3KooWIdleKey', started: false }, { address: '12D3KooWRunning', publicKey: '12D3KooWRunning', started: true }]

  async function started (extra: Parameters<typeof setup>[0] = {}) {
    const run = await setup({ communities: COMMUNITIES, ...extra })
    Object.assign(run.environment, { challenges: { registry: {} } })
    await startWorker(run.environment as never)
    return run
  }

  it('lists the boards the RPC server hosts, and reads the challenges of one that runs from the running community and of one that does not from the stored one', async () => {
    const run = await started({
      startedCommunities: { '12D3KooWRunning': { settings: { challenges: [WORD], pages: { posts: [] } } } },
      boardSettings: { 'idle.bso': { challenges: [BASE64], fetchThumbnailUrls: false } }
    })
    expect(await (await call(run, 'boards')).json()).toEqual({ boards: [{ address: '12D3KooWRunning', publicKey: '12D3KooWRunning', started: true }, { address: 'idle.bso', name: 'idle.bso', publicKey: '12D3KooWIdleKey', started: false }], ethereum: { path: 'public', why: 'unsupported' } })
    expect(await (await call(run, 'board', { address: '12D3KooWRunning' })).json()).toEqual({ address: '12D3KooWRunning', challenges: [WORD], otherSettings: ['pages'] })
    expect(await (await call(run, 'board', { address: 'idle.bso' })).json()).toEqual({ address: 'idle.bso', challenges: [BASE64], otherSettings: ['fetchThumbnailUrls'] })
    expect((await call(run, 'board', { address: 'nobody.bso' })).status).toBe(404)
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('applies a list through the RPC server\'s own edit, to the board\'s identity key and with the settings it had besides challenges', async () => {
    const run = await started({ boardSettings: { 'idle.bso': { challenges: [BASE64], fetchThumbnailUrls: false, pages: { posts: [] } } } })
    const answer = await call(run, 'apply', { address: 'idle.bso', challenges: [WORD, BASE64], expect: [BASE64] })
    expect(answer.status).toBe(200)
    expect(run.pkc.edits).toEqual([{ name: 'idle.bso', publicKey: '12D3KooWIdleKey', editOptions: { settings: { challenges: [WORD, BASE64], fetchThumbnailUrls: false, pages: { posts: [] } } } }])
    expect(await answer.json()).toMatchObject({ address: 'idle.bso', challenges: [WORD, BASE64], otherSettings: ['fetchThumbnailUrls', 'pages'] })
    expect((await call(run, 'apply', { address: 'idle.bso', challenges: [], expect: [BASE64] })).status).toBe(409)
    expect(run.pkc.edits).toHaveLength(1)
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('needs the key, and says 503 in a build with no challenges', async () => {
    const run = await started()
    expect((await call(run, 'boards', {}, null)).status).toBe(401)
    expect((await call(run, 'apply', { address: 'idle.bso', challenges: [] }, 'wrong')).status).toBe(401)
    expect(run.pkc.edits).toEqual([])
    await run.handlers[0]!({ cmd: 'stop' })
    const bare = await setup({ communities: COMMUNITIES })
    await startWorker(bare.environment as never)
    expect((await call(bare, 'boards')).status).toBe(503)
    expect((await call(bare, 'apply', { address: 'idle.bso', challenges: [] })).status).toBe(503)
    await bare.handlers[0]!({ cmd: 'stop' })
  })
})

describe('the name calls', () => {
  const BOARD = '12D3KooWJoFVU6rBeqCTZoPszCaWyENY5ahrTUsNpHqhfrpmwkZD'
  const nameCall = (run: Awaited<ReturnType<typeof setup>>, call: string, body: unknown = {}, key: string | null = KEY) => fetch(`http://127.0.0.1:${String(run.config.ports.gateway)}/orivon/name/${call}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key === null ? {} : { Authorization: `Bearer ${key}` }) }, body: JSON.stringify(body) })

  it('are on the gateway\'s socket with the key: the boards the RPC server hosts, and the record a name must hold for one', async () => {
    const run = await setup({ communities: [{ address: BOARD, started: true }] })
    await startWorker(run.environment as never)
    expect(await (await nameCall(run, 'boards')).json()).toEqual({ boards: [{ address: BOARD, name: null, publicKey: BOARD }], ethereum: { path: 'public', why: 'unsupported' } })
    expect(await (await nameCall(run, 'record', { address: BOARD, name: 'yours.bso' })).json()).toEqual({ address: BOARD, name: 'yours.bso', ensName: 'yours.eth', key: 'bitsocial', value: BOARD })
    expect((await nameCall(run, 'boards', {}, null)).status).toBe(401)
    expect((await nameCall(run, 'sign', { address: BOARD })).status).toBe(403)
    expect((await nameCall(run, 'record', { address: 'nobody.bso', name: 'yours.bso' })).status).toBe(404)
    await run.handlers[0]!({ cmd: 'stop' })
  })
})

describe('how the node is reached, and seeding', () => {
  const RELAY = '/ip4/145.40.68.4/tcp/4001/p2p/12D3KooWRelayRelay'
  const door = (run: Awaited<ReturnType<typeof setup>>, path: string, call: string, body: unknown = {}, key: string | null = KEY) => fetch(`http://127.0.0.1:${String(run.config.ports.gateway)}/orivon/${path}/${call}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key === null ? {} : { Authorization: `Bearer ${key}` }) }, body: JSON.stringify(body) })
  const flags = ['--publish', '--key-secret', '--punch-port', '--relay']

  it('starts the node again with the relay a person names, keeps it for the next Worker, and starts it again without it when it is removed', async () => {
    const run = await setup({ flags, features: 'serve,listen,relay', status: { relays: [`${RELAY}/p2p-circuit/p2p/12D3KooWnode`], reach: { state: 'public', reason: 'named-relay' } } })
    Object.assign(run.environment, { fs: realFs })
    await startWorker(run.environment as never)
    expect(run.spawned[0]).not.toContain('--relay')
    const before = await (await door(run, 'reach', 'state')).json()
    expect(before).toMatchObject({ node: 'up', reachability: 'public', reason: 'named-relay', relay: { address: null, supported: true, holds: false }, circuits: [{ relay: RELAY, named: false }] })
    const saved = await door(run, 'reach', 'relay/set', { relay: RELAY })
    expect(await saved.json()).toMatchObject({ relay: { address: RELAY, source: 'saved', holds: true } })
    for (let i = 0; i < 200 && run.spawned.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(run.children[0]!.killed).toBe(true)
    expect(run.spawned[1]!.slice(run.spawned[1]!.indexOf('--relay'), run.spawned[1]!.indexOf('--relay') + 2)).toEqual(['--relay', RELAY])
    expect(realFs.readFileSync(`${run.config.files}/relay.json`, 'utf-8')).toContain(RELAY)
    expect((await door(run, 'reach', 'relay/set', { relay: 'relay.example' })).status).toBe(400)
    await door(run, 'reach', 'relay/remove')
    for (let i = 0; i < 200 && run.spawned.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(run.spawned[2]).not.toContain('--relay')
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('refuses a relay for a node component with no --relay (409), and keeps the door behind the key', async () => {
    const run = await setup({ flags: ['--publish', '--key-secret', '--punch-port'] })
    await startWorker(run.environment as never)
    expect((await door(run, 'reach', 'relay/set', { relay: RELAY })).status).toBe(409)
    expect((await door(run, 'reach', 'state', {}, null)).status).toBe(401)
    expect(run.spawned).toHaveLength(1)
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('has seeding off by default, answers 503 in a build with no file API, and follows a community through the RPC server\'s pkc-js once a person turns it on', async () => {
    const without = await setup()
    await startWorker(without.environment as never)
    expect((await door(without, 'seeding', 'state')).status).toBe(503)
    await without.handlers[0]!({ cmd: 'stop' })

    const run = await setup({ communities: [{ address: 'mine.bso' }] })
    const opened: string[] = []
    Object.assign(run.environment, { fs: realFs })
    const server = run.environment.PKCRpc.PKCWsServer
    run.environment.PKCRpc.PKCWsServer = async (given: Record<string, any>) => {
      const made = await server(given)
      Object.assign(made.pkc, { createCommunity: async ({ address }: { address: string }) => { opened.push(address); return Object.assign(new EventEmitter(), { update: async () => {}, stop: async () => {} }) } })
      return made
    }
    await startWorker(run.environment as never)
    expect(await (await door(run, 'seeding', 'state')).json()).toMatchObject({ enabled: false, communities: [] })
    await door(run, 'seeding', 'follow', { addresses: ['mine.bso', 'theirs.bso'] })
    await door(run, 'seeding', 'enable')
    for (let i = 0; i < 200 && opened.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(opened).toEqual(['theirs.bso'])
    const state = (await (await door(run, 'seeding', 'state')).json()) as { communities: Array<Record<string, unknown>> }
    expect(state.communities.map((one) => [one['address'], one['status']])).toEqual([['mine.bso', 'hosted'], ['theirs.bso', 'waiting']])
    await run.handlers[0]!({ cmd: 'stop' })
  })
})

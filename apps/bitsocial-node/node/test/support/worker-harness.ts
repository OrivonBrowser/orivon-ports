// A Worker run against stand-ins for the node and for pkc-js's server, shared by the Worker's test files: `setup` builds the environment
// `startWorker` takes and what a test reads back (what was sent to the page, what was spawned, the options pkc-js was given).
import { EventEmitter } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { afterEach, beforeEach } from 'vitest'

export const KEY = 'worker-test-key-0123456789abcdef'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill () { this.killed = true; queueMicrotask(() => { this.emit('exit', null, 'SIGTERM') }); return true }
}

async function freePorts (count: number): Promise<number[]> {
  const servers = await Promise.all(Array.from({ length: count }, () => new Promise<net.Server>((resolve) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { resolve(server) }) })))
  const ports = servers.map((server) => (server.address() as net.AddressInfo).port)
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  return ports
}

let dir: string
/** Gives each test of the calling file its own folder for the Worker's files: call it once at the top of the file. */
export function useWorkerFolder (): void {
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bitsocial-worker-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
}

export async function setup (options: { nodeAnswers?: boolean, occupy?: 'rpc' | 'gateway', rpcDelayMs?: number, limitRefusals?: number, flags?: string[], publishing?: string, nodeGone?: boolean, punch?: Record<string, unknown>, status?: Record<string, unknown>, relay?: string, features?: string, bandwidth?: Record<string, unknown> | number, communities?: Array<{ address: string, started?: boolean, name?: string, publicKey?: string }>, startedCommunities?: Record<string, { features?: Record<string, unknown>, settings?: Record<string, unknown> }>, boardSettings?: Record<string, Record<string, unknown>> } = {}) {
  const [rpc, gateway, kubo, nodeApi, p2p] = await freePorts(5) as [number, number, number, number, number]
  const sent: Array<Record<string, any>> = []
  const events: string[] = []
  const children: FakeChild[] = []
  const files = new Map<string, string>()
  const spawned: string[][] = []
  const exits: number[] = []
  const removed: string[] = []
  const handlers: Array<(message: unknown) => void> = []
  const lines: string[] = []
  const warnings: string[] = []
  const bandwidthAsked: Array<string | null> = []
  const pkc = { options: null as null | Record<string, any>, destroyed: false, order: [] as string[], edits: [] as Array<Record<string, any>> }
  let refused = 0
  const blocker = options.occupy === undefined ? null : net.createServer()
  if (blocker !== null) await new Promise<void>((resolve) => { blocker.listen(options.occupy === 'rpc' ? rpc : gateway, '127.0.0.1', resolve) })
  const originalFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.port !== String(nodeApi)) throw new TypeError(`fetch failed: ${url.href}`)
    if (options.nodeGone === true && children.length === 0) throw new TypeError(`fetch failed: ${url.href}`)
    if (options.nodeAnswers === false) return new Response('starting', { status: 503 })
    if (url.pathname === '/health') return new Response('ok\n', { headers: options.features === undefined ? {} : { 'x-orivon-node-features': options.features } })
    if (url.pathname === '/orivon/stats/bw' && options.bandwidth !== undefined) {
      bandwidthAsked.push(new Headers((input instanceof Request ? input : init)?.headers).get('x-orivon-key'))
      return typeof options.bandwidth === 'number' ? new Response('no', { status: options.bandwidth }) : Response.json(options.bandwidth)
    }
    if (url.pathname === '/orivon/publishing') return Response.json({ keys: options.publishing ?? 'sealed', ...(options.punch === undefined ? {} : { punch: options.punch }) })
    if (url.pathname === '/status') return Response.json({ peer: '12D3KooWnode', reachability: 'unknown', listen: [], external: [], ...options.status })
    return new Response('no such route', { status: 404 })
  }) as typeof fetch
  const scope = { fetch: originalFetch }
  const wrappedHttp = { ...http, createServer: (...args: Parameters<typeof http.createServer>) => { const server = http.createServer(...args); server.on('listening', () => { events.push(`listening ${String((server.address() as net.AddressInfo).port)}`) }); return server } }
  const PKCRpc = {
    async PKCWsServer (given: Record<string, any>) {
      if (refused < (options.limitRefusals ?? 0)) { refused += 1; throw Object.assign(new Error('this origin is calling too frequently; wait and retry'), { code: 'limit' }) }
      pkc.options = given
      if (options.rpcDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.rpcDelayMs))
      // pkc-js attaches a WebSocket server to the server it is handed and trusts a loopback client with no key.
      const sockets = new WebSocketServer({ server: given['server'], verifyClient: (_info: unknown, done: (ok: boolean) => void) => { done(true) } })
      sockets.on('error', () => {})
      const getStartedCommunity = async (address: string) => {
        const community = options.startedCommunities?.[address]
        if (community === undefined) throw new Error('Can\'t call getStartedCommunity when the community hasn\'t been started')
        return { address, ...community }
      }
      const stored = options.boardSettings ?? {}
      const editCommunity = async ([param]: Array<{ name?: string, publicKey?: string, editOptions: { settings: Record<string, unknown> } }>) => {
        pkc.edits.push(param!)
        const address = (options.communities ?? []).find((one) => one.publicKey === param!.publicKey || one.name === param!.name)?.address ?? ''
        stored[address] = param!.editOptions.settings
        return { settings: stored[address] }
      }
      return { on () {}, getStartedCommunity, editCommunity, pkc: { communities: options.communities ?? [], createCommunity: async ({ address }: { address: string }) => ({ address, settings: stored[address] }) }, async destroy () { pkc.order.push('rpc destroyed'); pkc.destroyed = true; for (const client of sockets.clients) client.terminate(); sockets.close() } }
    }
  }
  const config = { authKey: KEY, files: join(dir, 'files'), ports: { rpc, gateway, kubo, nodeApi, p2p }, origins: [], trace: 'warn', ...(options.relay === undefined ? {} : { relay: options.relay }) }
  const environment = {
    env: { BITSOCIAL_NODE: JSON.stringify(config) } as Record<string, string>,
    send: (message: Record<string, any>) => { sent.push(message); events.push(`send ${String(message['type'])}`) },
    onMessage: (handler: (message: unknown) => void) => { handlers.push(handler) },
    exit: (code: number) => { exits.push(code) },
    spawn: ((_program: string, args: string[]) => { const child = new FakeChild(); children.push(child); spawned.push(args); events.push(`spawn ${args.slice(0, 1).join('')}`); return child }) as never,
    fetch: originalFetch,
    http: wrappedHttp as unknown as typeof http,
    PKCRpc,
    scope,
    mkdir: async (path: string) => { const { mkdir } = await import('node:fs/promises'); await mkdir(path, { recursive: true }) },
    removeDir: async (path: string) => { removed.push(path.replace(`${dir}/files/`, '')); events.push(`remove ${path.split('/').at(-1) ?? ''}`); return true },
    randomHex: () => 'f'.repeat(64),
    readText: async (path: string) => files.get(path) ?? null,
    writeText: async (path: string, text: string) => { files.set(path, text) },
    nodeFlags: (options.flags ?? []) as string[],
    rpcRetryMs: 5,
    log: (line: string) => { lines.push(line) },
    warn: (line: string) => { warnings.push(line) },
    timing: { startWaitMs: 300, pollMs: 10, settleMs: 20, maxPauseMs: 40, killWaitMs: 100, firstStartAttempts: 1 }
  }
  const stopBlocker = async (): Promise<void> => { if (blocker !== null) await new Promise((resolve) => blocker.close(resolve)) }
  return { environment, config, sent, events, children, files, spawned, exits, removed, handlers, pkc, scope, originalFetch, stopBlocker, lines, warnings, bandwidthAsked }
}

/** Whether a WebSocket opens at `path` of the RPC port. */
export function opens (port: number, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${path}`)
    socket.onopen = () => { socket.close(); resolve(true) }
    socket.onerror = () => { resolve(false) }
  })
}

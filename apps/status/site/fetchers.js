// Every network request the page makes goes through here: plain fetch, a 20 s timeout, and a
// line in the row's request log (host, status, seconds). Blocks are hash-checked before they
// are returned, so a gateway cannot hand over bytes the address does not name.

import { text } from './bytes.js'
import { parseCid } from './cid.js'
import { contenthashCall, decodeAbiBytes, decodeAddress, decodeContenthash, namehash, resolverCall } from './ens.js'
import { GATEWAYS, GITHUB_API, RECORD_GATEWAYS, ROUTING, RPCS } from './targets.js'
import { verifyBlock } from './verify.js'

export const REQUEST_TIMEOUT_MS = 20_000
const MAX_BLOCK_BYTES = 4 * 1024 * 1024
const BLOCKS_IN_FLIGHT = 6

/**
 * @typedef {{ label: string, host: string, status: string, ms: number }} RequestLine
 * @typedef {{
 *   log: RequestLine[], order: string[], onLog: () => void,
 *   slots: () => Promise<() => void>
 * }} Context
 */

/**
 * One context per row: its own request log, its own gateway order, its own limit of six
 * blocks in flight.
 * @param {() => void} [onLog] called after every request line
 * @returns {Context}
 */
export function createContext (onLog = () => {}) {
  let active = 0
  /** @type {(() => void)[]} */
  const waiting = []
  const release = () => {
    active--
    waiting.shift()?.()
  }
  return {
    log: [],
    order: [...GATEWAYS],
    onLog,
    slots: async () => {
      if (active >= BLOCKS_IN_FLIGHT) await new Promise((resolve) => waiting.push(() => resolve(undefined)))
      active++
      return release
    }
  }
}

/**
 * @param {Context} ctx
 * @param {string} label what the request is for
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<{ ok: boolean, status: string, bytes: Uint8Array, ms: number }>}
 */
export async function timedFetch (ctx, label, url, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const started = performance.now()
  let status = 'error'
  let ok = false
  let bytes = new Uint8Array(0)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
    status = String(response.status)
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > MAX_BLOCK_BYTES && label.startsWith('block')) throw new Error('block too large')
    bytes = new Uint8Array(await response.arrayBuffer())
    ok = response.ok
  } catch (error) {
    status = controller.signal.aborted ? 'timeout' : error instanceof Error && error.message === 'block too large' ? 'too large' : 'network error'
  } finally {
    clearTimeout(timer)
  }
  const ms = performance.now() - started
  ctx.log.push({ label, host: new URL(url).host, status, ms })
  ctx.onLog()
  return { ok, status, bytes, ms }
}

/**
 * A block from the first gateway that returns bytes the CID verifies. A gateway that
 * answered once is tried first for the rest of the row. Throws after every gateway failed.
 * @param {Context} ctx
 * @param {string} cid
 * @param {{ aborted: boolean }} scope set aborted to stop queued fetches
 * @returns {Promise<{ bytes: Uint8Array, gateway: string, ms: number }>}
 */
export async function fetchBlock (ctx, cid, scope) {
  const parsed = parseCid(cid)
  const release = await ctx.slots()
  try {
    /** @type {string[]} */
    const failures = []
    for (const gateway of [...ctx.order]) {
      if (scope.aborted) throw new Error('stopped')
      const label = `block ${cid.slice(0, 12)}…`
      const reply = await timedFetch(ctx, label, `${gateway}/ipfs/${cid}?format=raw`, { headers: { Accept: 'application/vnd.ipld.raw' } })
      if (!reply.ok) {
        failures.push(`${new URL(gateway).host} ${reply.status}`)
        continue
      }
      const check = await verifyBlock(parsed, reply.bytes)
      if (!check.ok) {
        const line = ctx.log[ctx.log.length - 1]
        if (line) line.status = 'hash mismatch'
        failures.push(`${new URL(gateway).host} sent bytes that do not match`)
        continue
      }
      ctx.order = [gateway, ...ctx.order.filter((other) => other !== gateway)]
      return { bytes: reply.bytes, gateway: new URL(gateway).host, ms: reply.ms }
    }
    throw new Error(`No gateway could fetch block ${cid.slice(0, 14)}… (${failures.join('; ')})`)
  } finally {
    release()
  }
}

/**
 * @typedef {{ ok: true, value: unknown, host: string } | { ok: false, reverted: boolean, error: string }} RpcResult
 */

/**
 * eth_call against each RPC in turn. An execution revert is an answer (the contract has no
 * such function); a network failure or a rate limit moves on to the next RPC.
 * @param {Context} ctx
 * @param {{ to: string, data: string }} call
 * @returns {Promise<RpcResult>}
 */
export async function ethCall (ctx, call) {
  let last = 'no RPC answered'
  for (const rpc of RPCS) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [call, 'latest'] })
    const reply = await timedFetch(ctx, 'eth_call', rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    if (!reply.ok) {
      last = `${new URL(rpc).host} ${reply.status}`
      continue
    }
    try {
      const json = JSON.parse(text(reply.bytes))
      if (typeof json.result === 'string') return { ok: true, value: json.result, host: new URL(rpc).host }
      const message = String(json.error?.message ?? '')
      if (json.error?.code === 3 || /revert/i.test(message)) return { ok: false, reverted: true, error: message }
      last = `${new URL(rpc).host}: ${message || 'no result'}`
    } catch {
      last = `${new URL(rpc).host} sent something that is not JSON`
    }
  }
  return { ok: false, reverted: false, error: last }
}

/**
 * What a .eth name's contenthash says, asked of Ethereum's registry and the name's resolver.
 * @param {Context} ctx
 * @param {string} name
 * @returns {Promise<{ status: 'ok' | 'noresolver' | 'nocontenthash' | 'unreachable' | 'found', contenthash?: ReturnType<typeof decodeContenthash>, detail?: string }>}
 */
export async function lookupName (ctx, name) {
  const node = namehash(name)
  const registry = await ethCall(ctx, resolverCall(node))
  if (!registry.ok) return { status: 'unreachable', detail: registry.error }
  const resolver = decodeAddress(String(registry.value))
  if (!resolver) return { status: 'noresolver' }
  const answer = await ethCall(ctx, contenthashCall(resolver, node))
  if (!answer.ok) return answer.reverted ? { status: 'nocontenthash' } : { status: 'unreachable', detail: answer.error }
  let bytes
  try {
    bytes = decodeAbiBytes(String(answer.value))
  } catch (error) {
    return { status: 'unreachable', detail: `the resolver's answer was malformed (${error instanceof Error ? error.message : error})` }
  }
  const contenthash = decodeContenthash(bytes)
  return contenthash.kind === 'empty' ? { status: 'nocontenthash' } : { status: 'found', contenthash }
}

const RECORD_TYPE = 'application/vnd.ipfs.ipns-record'

/**
 * The raw IPNS record from each record gateway, asked in parallel.
 * @param {Context} ctx
 * @param {string} key
 * @returns {Promise<{ source: string, ok: boolean, status: string, bytes: Uint8Array, ms: number }[]>}
 */
export function fetchRecords (ctx, key) {
  const sources = RECORD_GATEWAYS.map((gateway) => ({ base: gateway, url: `${gateway}/ipns/${key}?format=ipns-record` }))
  return Promise.all(sources.map(async ({ base, url }) => {
    const reply = await timedFetch(ctx, 'ipns record', url, { headers: { Accept: RECORD_TYPE } })
    return { source: new URL(base).host, ...reply }
  }))
}

/**
 * How many peers the routing service lists as providers of a CID. Never their identities.
 * @param {Context} ctx
 * @param {string} cid
 * @returns {Promise<{ status: 'ok', count: number } | { status: 'error', error: string }>}
 */
export async function countProviders (ctx, cid) {
  const reply = await timedFetch(ctx, 'providers', `${ROUTING}/routing/v1/providers/${cid}`, { headers: { Accept: 'application/json' } })
  if (reply.status === '404') return { status: 'ok', count: 0 }
  if (!reply.ok) return { status: 'error', error: `the routing service answered ${reply.status}` }
  try {
    const json = JSON.parse(text(reply.bytes))
    return { status: 'ok', count: Array.isArray(json.Providers) ? json.Providers.length : 0 }
  } catch {
    return { status: 'error', error: 'the routing service sent something that is not JSON' }
  }
}

/**
 * @param {Context} ctx
 * @param {string} repo owner/name
 */
export async function fetchReleases (ctx, repo) {
  const reply = await timedFetch(ctx, 'releases', `${GITHUB_API}/repos/${repo}/releases?per_page=10`, { headers: { Accept: 'application/vnd.github+json' } })
  if (!reply.ok) throw new Error(`GitHub answered ${reply.status}`)
  return JSON.parse(text(reply.bytes))
}

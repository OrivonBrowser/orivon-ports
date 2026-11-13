// What the fork run shares: an anvil fork of mainnet, a funded throwaway key behind a stand-in for the browser's handles, the setup a
// case may need (as an account the fork lets act without its key, or as the wrapper's owner), and the resolver's own answer for a name.
// Nothing is ever sent to mainnet: every transaction goes to the fork.

import { spawn, spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { encodeCall } from '../site/sdk/abi.js'
import { toHex } from '../site/sdk/bytes.js'
import { namehash } from '../site/sdk/ens.js'
import { callQueue, orivonChain } from '../site/sdk/chain-orivon.js'
import { readCensus } from '../site/resolver/og-census.js'
import { resolveOg } from '../site/resolver/og-names.js'
import { WRAPPER } from '../site/resolver/og-pins.js'
import { createSession } from '../site/resolver/og-tail.js'
import { createManage } from '../site/manage-flow.js'
import { createRegistration } from '../site/register-flow.js'
import { orivonSender } from '../site/register-send.js'
import { freezeTip, resolveTipAddress, TIP } from '../site/register-tip.js'
import { addressOfKey } from './fork-signer.mjs'
import { forkOrivon, rpc } from './fork-handles.mjs'

export const NODES = [...(process.env['ORIVON_OG_FORK_RPC'] === undefined ? [] : [process.env['ORIVON_OG_FORK_RPC']]), 'https://ethereum-rpc.publicnode.com', 'https://rpc.mevblocker.io', 'https://rpc.flashbots.net']
const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
const PUBLIC_RESOLVER = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63'
export const TIP_RECEIVER = '0x000000000000000000000000000000000000dEaD'
export const SITE = { key: 'content.ipfs', text: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' }
const ONE_GWEI_CALM = { sleep: async () => {} }
// A fork that has not read a contract's storage yet asks the public node for each slot, so the first send of a run can take a minute.
const WAIT = { intervalMs: 50, timeoutMs: 180_000 }
export const BIG = (/** @type {unknown} */ value) => (typeof value === 'bigint' ? value.toString() : value)

/** @returns {Promise<number>} */
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    server.close(() => { typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no port')) })
  })
})

/** @param {string} node @param {NodeJS.ProcessEnv} env */
async function forkOf (node, env) {
  const port = await freePort()
  // The fork is pinned a few blocks behind the node's head, so what anvil fetched is kept on disk and a second run asks the node for little;
  // a public node answers 429 to a fast reader, so anvil reads slowly and tries again.
  const head = Number(await rpc(node, 'eth_blockNumber', [])) - 3
  const child = spawn('anvil', [
    '--fork-url', node, '--fork-block-number', String(head), '--host', '127.0.0.1', '--port', String(port), '--chain-id', '1',
    '--compute-units-per-second', '40', '--retries', '10', '--fork-retry-backoff', '1500', '--timeout', '60000', '--silent'
  ], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let failure = ''
  child.stderr?.on('data', (chunk) => { failure += String(chunk) })
  process.once('exit', () => child.kill('SIGKILL'))
  const url = `http://127.0.0.1:${port}`
  for (let waited = 0; waited < 120_000; waited += 250) {
    try {
      await rpc(url, 'eth_blockNumber', [])
      return { url, node, stop: () => child.kill('SIGTERM') }
    } catch {
      if (child.exitCode !== null) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  child.kill('SIGKILL')
  throw new Error(`anvil did not start from ${node}: ${failure.trim().slice(0, 300) || 'no output'}`)
}

export async function startFork () {
  const env = { ...process.env, PATH: `${process.env['HOME']}/.foundry/bin:${process.env['PATH']}` }
  if (spawnSync('anvil', ['--version'], { env, stdio: 'ignore' }).status !== 0) throw new Error('anvil is not installed (Foundry)')
  const failures = []
  for (const node of NODES) {
    try {
      return await forkOf(node, env)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`no public node could be forked: ${failures.join(' | ')}`)
}

/** @typedef {{ name: string, run: () => Promise<Record<string, unknown>> }} Case */
/** @typedef {Awaited<ReturnType<typeof createWorld>>} World */

/**
 * The helpers of one fork.
 * @param {{ url: string }} fork
 */
export async function createWorld (fork) {
  const { url } = fork
  const census = readCensus(JSON.parse(await readFile(new URL('../site/resolver/census.json', import.meta.url), 'utf8')))
  const ask = (/** @type {string} */ method, /** @type {unknown[]} */ ...params) => rpc(url, method, params)
  const quantity = (/** @type {bigint} */ value) => `0x${value.toString(16)}`

  /** Sends as an account the fork lets act without its key. @param {string} from @param {string} to @param {string} data */
  async function sendAs (from, to, data) {
    await ask('anvil_impersonateAccount', from)
    await ask('anvil_setBalance', from, quantity(10n ** 19n))
    const hash = /** @type {string} */ (await ask('eth_sendTransaction', { from, to, data, gas: quantity(500_000n) }))
    /** @type {any} */
    let receipt = null
    for (let tries = 0; receipt === null && tries < 100; tries++) {
      receipt = await ask('eth_getTransactionReceipt', hash)
      if (receipt === null) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (receipt?.status !== '0x1') throw new Error(`setup transaction from ${from} to ${to} failed: ${JSON.stringify(receipt)?.slice(0, 200)}`)
  }

  const hexOf = (/** @type {Uint8Array} */ bytes) => `0x${toHex(bytes)}`

  /** `orivonstack.eth` has no resolver on mainnet today, so the fork gives it one that answers the tip's address, as ENS's own contracts would. */
  async function plantTipResolver () {
    const node = namehash(TIP.name)
    const owner = /** @type {string} */ (await ask('eth_call', { to: ENS_REGISTRY, data: hexOf(encodeCall('owner(bytes32)', [node])) }, 'latest'))
    const holder = `0x${owner.slice(-40)}`
    // The name's owner is a contract; on the fork its code is cleared so the address can send as itself, which EIP-3607 refuses otherwise.
    await ask('anvil_setCode', holder, '0x')
    await sendAs(holder, ENS_REGISTRY, hexOf(encodeCall('setResolver(bytes32,address)', [node, PUBLIC_RESOLVER])))
    await sendAs(holder, PUBLIC_RESOLVER, hexOf(encodeCall('setAddr(bytes32,address)', [node, TIP_RECEIVER])))
  }

  /** Flips the wrapper's `wrapEnabled`, as its owner can. */
  async function flipWrapping () {
    const owner = /** @type {string} */ (await ask('eth_call', { to: WRAPPER, data: hexOf(encodeCall('owner()', [])) }, 'latest'))
    await sendAs(`0x${owner.slice(-40)}`, WRAPPER, hexOf(encodeCall('changeWrapEnabled()', [])))
  }

  /** The address the tip goes to on this fork, as the page's own lookup finds it. @param {ReturnType<typeof orivonChain>} chain */
  async function tipAddress (chain) {
    const found = await resolveTipAddress(chain)
    if (!found.ok) throw new Error(`the tip's name does not resolve on the fork: ${found.words}`)
    return found.address
  }

  /** @param {string} address */
  const balance = async (address) => BigInt(/** @type {string} */ (await ask('eth_getBalance', address, 'latest')))

  /**
   * One registration by a new funded key. `beforeSend(index, context)` runs before the nth raw transaction reaches the node.
   * @param {object} want
   * @param {string} want.label
   * @param {boolean} [want.series]
   * @param {boolean} [want.wrapped]
   * @param {boolean} [want.tip]
   * @param {Uint8Array} [want.key] a key to go on with, to continue what an earlier run of the case left
   * @param {(index: number, context: { label: string, account: string }, raw: Uint8Array) => Promise<void>} [want.beforeSend]
   */
  async function register ({ label, series = true, wrapped = true, tip = true, key = randomBytes(32), beforeSend }) {
    const account = addressOfKey(key)
    await ask('anvil_setBalance', account, quantity(10n ** 19n))
    const handles = forkOrivon({ url, key, series, beforeSend: beforeSend === undefined ? undefined : (index, raw) => beforeSend(index, { label, account }, raw) })
    const chain = orivonChain(/** @type {any} */ (handles.orivon), { queue: callQueue({ burst: 1e6, perSecond: 1e6 }) })
    const sender = orivonSender({ orivon: /** @type {any} */ (handles.orivon), chain, relay: { send: async () => { throw new Error('the relay was not asked for') } } })
    const flow = createRegistration({ chain, sender, onState: () => {}, clock: ONE_GWEI_CALM, wait: WAIT })
    const start = async (/** @type {boolean} */ wrap) => {
      const frozen = await freezeTip(chain, { ticked: tip, amountText: TIP.defaultText, shown: null, account })
      return await flow.start({ label, account, wrapped: wrap, site: SITE, tip: frozen.tip, private: false })
    }
    /** What "Continue" does after a stop: the request the stopped run reported, started again. @param {Record<string, any>} stopped */
    const continueFrom = async (stopped) => await flow.start(stopped['request'])
    /** One change to a name, as the page's manage flow plans and sends it. @param {Record<string, unknown>} request */
    const change = async (request) => {
      const flow = createManage({ chain, sender, onState: () => {}, clock: ONE_GWEI_CALM, wait: WAIT })
      return await flow.start(/** @type {any} */ ({ account, private: false, ...request }))
    }
    return { account, key, handles, chain, start: () => start(wrapped), startWith: start, continueFrom, change }
  }

  /** What the resolver answers for the name, and why, read the way the page reads it. @param {string} label @param {ReturnType<typeof orivonChain>} chain */
  async function resolverSays (label, chain) {
    const session = createSession()
    const lookup = { session, census }
    const { inspectOg } = await import('../site/resolver/og-names.js')
    const answer = await resolveOg(chain, `${label}.og`, lookup)
    const inspected = await inspectOg(chain, label, lookup, { latest: true })
    return { records: answer.records, reasons: Object.fromEntries(Object.entries(inspected.verdict?.keys ?? {}).map(([name, found]) => [name, found.reason])) }
  }

  /** @param {Record<string, any>} view */
  function summary (view) {
    return {
      phase: view['phase'], stop: view['outcome']?.kind ?? null, stoppedAt: view['outcome']?.at ?? null, offer: view['outcome']?.offer ?? null,
      steps: view['steps'].map((/** @type {any} */ step) => `${step.id}:${step.state}${step.gasUsed === null ? '' : `:${step.gasUsed}`}`),
      gasUsed: view['costs'].gasUsed, tipWei: view['costs'].tipWei
    }
  }

  /** @param {boolean} ok @param {string} what @param {unknown} [detail] */
  const check = (ok, what, detail) => { if (!ok) throw new Error(`failed: ${what}${detail === undefined ? '' : ` ${JSON.stringify(detail, (_, value) => BIG(value))}`}`) }

  return {
    url, census, ask, quantity, sendAs, hexOf, plantTipResolver, tipAddress, flipWrapping, balance, register, resolverSays, summary, check
  }
}

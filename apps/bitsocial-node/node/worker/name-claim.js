// Giving a board a name, as far as the node knows it: the name as ENS spells it, the text record the name must hold, the transaction
// that sets it, and the check pkc-js's own name resolvers would make of whether the name points at the board. A `.bso` name is the
// ENS `.eth` name of the same label (pkc-js and `@bitsocial/bso-resolver` read both spellings the same way), and the record is the
// text record `bitsocial` of that name, holding the board's public key; the transaction is the name's resolver's `setText`.

import { createPublicClient, encodeFunctionData, http } from 'viem'
import { mainnet } from 'viem/chains'
import { namehash, normalize } from 'viem/ens'

/** The text record key `@bitsocial/bso-resolver` reads. */
export const RECORD_KEY = 'bitsocial'
/** The time one resolver, and one provider, is given before the next is asked: pkc-js's own resolve is bounded by its caller, and a page waits here. */
export const RESOLVE_MS = 8_000
const NAME_MAX = 253
const REASON_MAX = 160
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
/** The ENS registry on Ethereum mainnet. */
const ENS_REGISTRY = /** @type {const} */ ('0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e')
const RESOLVER_OF = /** @type {const} */ ([{ type: 'function', name: 'resolver', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ name: '', type: 'address' }] }])
const SET_TEXT = /** @type {const} */ ([{ type: 'function', name: 'setText', stateMutability: 'nonpayable', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }, { name: 'value', type: 'string' }], outputs: [] }])

/** A request the node answers with a status: 400 a name that cannot be one, 409 what cannot be done to it, 502 and 503 Ethereum not being read. */
export class NameClaimError extends Error {
  /** @param {string} message @param {number} status */
  constructor (message, status) { super(message); this.status = status }
}

/**
 * A name as the person typed it and as ENS spells it. pkc-js refuses a board address with a capital letter, and ENS refuses a name it
 * writes differently, so a name that is neither is refused here before any record is made for it.
 * @param {unknown} name @returns {{ name: string, ensName: string }}
 */
export function ensNameOf (name) {
  if (typeof name !== 'string' || name === '' || name.length > NAME_MAX || !/\.(bso|eth)$/.test(name)) throw new NameClaimError('The name must end .bso or .eth', 400)
  if (name !== name.toLowerCase()) throw new NameClaimError(`${name} has a capital letter: pkc-js refuses a board address with one, so write the name in lower case`, 400)
  const ensName = name.endsWith('.bso') ? `${name.slice(0, -4)}.eth` : name
  let written
  try { written = normalize(ensName) } catch { throw new NameClaimError(`${name} is not a name ENS accepts`, 400) }
  if (written !== ensName) throw new NameClaimError(`${name} is not a name ENS accepts as it is written: ENS writes it ${written}`, 400)
  return { name, ensName }
}

/**
 * Whether a text record may hold this as a board's key: what `@bitsocial/bso-resolver` accepts as the first segment of the record, a base-58 IPNS
 * public key of the shapes a board's address has (`12D3Koo...`, 52 characters, or `Qm...`, 46).
 * @param {unknown} value
 */
export function isBoardKey (value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return false
  if (value.startsWith('12D3Koo')) return value.length === 52
  return value.startsWith('Qm') && value.length === 46
}

/**
 * The record a name must hold to point at a board.
 * @param {{ name: unknown, publicKey: string }} board @returns {{ name: string, ensName: string, key: string, value: string }}
 */
export function recordOf ({ name, publicKey }) {
  const spelled = ensNameOf(name)
  if (!isBoardKey(publicKey)) throw new NameClaimError(`the key of this board (${String(publicKey).slice(0, 80)}) is not a key a name can hold: a name's record holds a key that starts 12D3Koo or Qm`, 409)
  return { ...spelled, key: RECORD_KEY, value: publicKey }
}

/** The calldata of the name's resolver's `setText(node, key, value)`. @param {{ ensName: string, value: string }} record */
export function setTextData ({ ensName, value }) {
  return encodeFunctionData({ abi: SET_TEXT, functionName: 'setText', args: [namehash(ensName), RECORD_KEY, value] })
}

/** A failure in a line, with no address in it: viem's errors carry the provider's URL, which may hold a key. @param {unknown} error */
function reasonOf (error) {
  const text = /** @type {any} */ (error)?.shortMessage ?? (error instanceof Error ? error.message : String(error))
  return String(text).split('\n')[0]?.trim().slice(0, REASON_MAX) ?? ''
}

/**
 * @typedef {{ key: string, provider?: string, canResolve: (options: { name: string }) => boolean, resolve: (options: { name: string, abortSignal?: AbortSignal }) => Promise<{ publicKey?: string } | undefined> }} NameResolver
 * @typedef {'here' | 'elsewhere' | 'none' | 'invalid' | 'unreachable' | 'no-resolver'} Outcome
 */

/**
 * Whether a name points at a board, asked as pkc-js asks: the name resolvers in order, those that cannot handle it skipped, a resolver that fails
 * left for the next, the first record found taken, and nothing remembered between two questions (pkc-js's cache of names is not read).
 * `none` means a resolver answered and holds no record; `unreachable` that none answered; `invalid` that a record exists and is not a board's key.
 * @param {{ name: string, publicKey: string, resolvers: NameResolver[], timeoutMs?: number }} options
 * @returns {Promise<{ outcome: Outcome, resolved: string | null, resolver: string | null, errors?: Array<{ resolver: string, message: string }> }>}
 */
export async function checkName ({ name, publicKey, resolvers, timeoutMs = RESOLVE_MS }) {
  let capable = 0
  let answered = false
  /** @type {Array<{ resolver: string, message: string }>} */
  const errors = []
  /** @type {string | undefined} */
  let value
  let by = null
  for (const one of resolvers) {
    if (!one.canResolve({ name })) continue
    capable += 1
    try {
      const result = await one.resolve({ name, abortSignal: AbortSignal.timeout(timeoutMs) })
      answered = true
      value = result?.publicKey
      if (value) { by = one.key; break }
    } catch (error) { errors.push({ resolver: one.key, message: reasonOf(error) }) }
  }
  if (capable === 0) return { outcome: 'no-resolver', resolved: null, resolver: null }
  if (value) return isBoardKey(value) ? { outcome: value === publicKey ? 'here' : 'elsewhere', resolved: value, resolver: by } : { outcome: 'invalid', resolved: null, resolver: by, errors: [{ resolver: String(by), message: 'the record is not a board key' }] }
  if (answered) return { outcome: 'none', resolved: null, resolver: null }
  return { outcome: errors.some((one) => /Invalid bitsocial TXT record/.test(one.message)) ? 'invalid' : 'unreachable', resolved: null, resolver: null, errors }
}

/** @param {string} url @param {number} timeoutMs */
function defaultClient (url, timeoutMs) {
  return createPublicClient({ chain: mainnet, transport: http(url === 'viem' ? undefined : url, { timeout: timeoutMs, retryCount: 0 }) })
}

/**
 * Reads, from Ethereum, which contract stores the records of a name: the ENS registry's `resolver(node)`, through the providers in order, the
 * first that answers. This is the contract a name manager writes to and a transaction must call. It is not viem's `getEnsResolver`, which
 * names the contract reads of the name go through: for a `.eth` name that is a forwarding contract with no records of its own and no `setText`.
 * Only the registry that holds every `.eth` name today is read (provisional: a name that lives only in ENSv2's own registries has none here).
 * @param {{ providers: string[], createClient?: (url: string) => { readContract: (options: { address: `0x${string}`, abi: typeof RESOLVER_OF, functionName: 'resolver', args: [`0x${string}`] }) => Promise<string> }, timeoutMs?: number }} options
 */
export function ethereumReader ({ providers, createClient, timeoutMs = RESOLVE_MS }) {
  const make = createClient ?? ((/** @type {string} */ url) => defaultClient(url, timeoutMs))
  return {
    /** The resolver's address, or null for a name that has none. @param {string} ensName @returns {Promise<string | null>} */
    async resolverOf (ensName) {
      if (providers.length === 0) throw new NameClaimError('this node reads no names: it has no Ethereum provider', 503)
      const node = namehash(normalize(ensName))
      /** @type {string[]} */
      const reasons = []
      for (const url of providers) {
        try {
          const address = await make(url).readContract({ address: ENS_REGISTRY, abi: RESOLVER_OF, functionName: 'resolver', args: [node] })
          return address === ZERO_ADDRESS ? null : address
        } catch (error) { reasons.push(reasonOf(error)) }
      }
      throw new NameClaimError(providers.length === 1 ? `Ethereum could not be read: ${reasons[0] ?? 'no answer'}` : `Ethereum could not be read through any of the node's ${String(providers.length)} providers: ${reasons[0] ?? 'no answer'}`, 502)
    }
  }
}

/**
 * What the node does for a page about a name: the check, through the name resolvers of the pkc-js instance that hosts the boards (so it is the
 * check the node itself makes when a board takes the name), and the transaction, read from the same providers.
 * @param {{ pkc: () => any, createClient?: Parameters<typeof ethereumReader>[0]['createClient'], timeoutMs?: number }} options `pkc` is the RPC server's pkc-js instance, or null while there is none
 */
export function nameClaims ({ pkc, createClient, timeoutMs = RESOLVE_MS }) {
  /** @returns {NameResolver[]} */
  const held = () => { const list = pkc()?.nameResolvers; return Array.isArray(list) ? list : [] }
  const providers = () => [...new Set(held().map((one) => one.provider).filter((provider) => typeof provider === 'string' && (provider === 'viem' || /^https?:\/\//.test(provider))))]
  return {
    /** @param {{ name: string, publicKey: string }} board */
    async check ({ name, publicKey }) {
      const { ensName } = ensNameOf(name)
      return { name, ensName, publicKey, ...await checkName({ name, publicKey, resolvers: held(), timeoutMs }) }
    },
    /** The transaction that sets the record, ready for a wallet. @param {{ name: string, publicKey: string }} board */
    async transaction ({ name, publicKey }) {
      const record = recordOf({ name, publicKey })
      const to = await ethereumReader({ providers: providers(), ...(createClient === undefined ? {} : { createClient }), timeoutMs }).resolverOf(record.ensName)
      if (to === null) throw new NameClaimError(`${record.ensName} has no resolver set, so it can hold no record yet: set one on it in a name manager (app.ens.domains), then come back here`, 409)
      return { ...record, chainId: 1, transaction: { to, data: setTextData(record), value: '0x0' } }
    }
  }
}

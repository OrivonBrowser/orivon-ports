// What the site knows about Orivon ID: the mainnet addresses, the label rules the registrar enforces, and
// reads of the registry and registrar through a Chain. Nothing here is trusted from a URL or a reverse record:
// a username belongs to an address only when `attribution` holds, read on chain at the time of use.

import { AbiError, decode, encodeCall, isAddress, sameAddress, toChecksumAddress, ZERO_ADDRESS } from './abi.js'
import { utf8 } from './bytes.js'
import { ChainError } from './chain.js'
import { labelhash, namehash } from './ens.js'
import { recordsHeld } from './permissions.js'
import { orElse, rawCall, readContract, readProfiles, resolveWith } from './read.js'
import { scanLogs } from './scan.js'

export { rawCall, readContract }
export { LABEL_REGISTERED, SCAN_WINDOW, TRANSFER_BATCH, TRANSFER_SINGLE } from './scan.js'

/** @typedef {import('./chain.js').Chain} Chain */
/** @typedef {import('./chain.js').BlockRef} BlockRef */

export const ADDRESSES = Object.freeze({
  r1: '0xDD1DecE58Eb7a5CebF8c1e0834b7eD4096e7ED20',
  r0: '0x84909f7e499C85dc47f9E4F5f068fd83B5A7c843',
  registrar: '0x27264C6AE4ec65fD14C0FB55C2Dc71eAa8956Cb4',
  safe: '0x13C71e5404E7741008Bbf8F4CA177f3EbbB3F356',
  ethRegistry: '0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2',
  dai: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  verifiableFactory: '0x77510ba162dfeA3d8989E3f0928a691B345730D2',
  resolverImplementation: '0x565b0F456a04Ac9b48758190e90030623Cff57C5'
})

export const SUFFIX = 'v1.orivonid.eth'

/** The block R1 was created in; no username event is older. */
export const FIRST_BLOCK = 26357113

/** Blocks the next scan repeats, in case the newest ones were replaced. */
export const REORG_MARGIN = 16

/** Held by the Safe from the start, so none can be bought. */
export const RESERVED = Object.freeze([
  'orivon', 'admin', 'support', 'official', 'offical', 'team', 'security', 'sp3rick', 'sperick', 'sp3rickhj',
  'sperickhj', 'attila', 'eth', 'orv', 'orivonid', 'orivonstack', '0rivon'
])

const DAI = 10n ** 18n

/** @param {string} label */
export const nameOf = (label) => `${label}.${SUFFIX}`

/**
 * What a person typed, ready to check: trimmed and lower-cased. Anything outside ASCII is refused before the
 * case is changed, because some non-ASCII letters lower-case into ASCII ones (the Kelvin sign into "k").
 * @param {unknown} input
 * @returns {{ ok: true, label: string } | { ok: false, reason: 'empty' | 'notAscii' }}
 */
export function normalizeInput (input) {
  const trimmed = typeof input === 'string' ? input.trim() : ''
  if (trimmed === '') return { ok: false, reason: 'empty' }
  if (/[^\x00-\x7f]/.test(trimmed)) return { ok: false, reason: 'notAscii' }
  return { ok: true, label: trimmed.toLowerCase() }
}

/**
 * Why the registrar would refuse a label, or null. Its `isValidLabel` is the rule; this names the first
 * reason in words a page can use.
 * @param {string} label
 * @returns {'tooShort' | 'tooLong' | 'edgeHyphen' | 'doubleHyphen' | 'badCharacter' | 'addressLike' | null}
 */
export function labelProblem (label) {
  const length = utf8(label).length
  if (length < 3) return 'tooShort'
  if (length > 63) return 'tooLong'
  if (label.startsWith('-') || label.endsWith('-')) return 'edgeHyphen'
  if (length >= 4 && label[2] === '-' && label[3] === '-') return 'doubleHyphen'
  if (!/^[a-z0-9-]+$/.test(label)) return 'badCharacter'
  if (/^0x[0-9a-f]{40}$/.test(label)) return 'addressLike'
  return null
}

/** Mirrors `OrivonIdV1Registrar.isValidLabel` exactly. @param {unknown} label */
export const isValidLabel = (label) => typeof label === 'string' && labelProblem(label) === null

/** @param {string} label */
export const isReserved = (label) => RESERVED.includes(label)

/** DAI in wei: 800 for three letters, 200 for four, 10 for more. Mirrors `OrivonIdV1Registrar.price`. @param {string} label */
export function price (label) {
  const length = utf8(label).length
  return (length === 3 ? 800n : length === 4 ? 200n : 10n) * DAI
}

/** The id R1 files a label under. @param {string} label */
export const labelId = (label) => BigInt(labelhash(label))

/** @param {string} address @returns {string | null} */
const nonZero = (address) => sameAddress(address, ZERO_ADDRESS) ? null : address

/**
 * Whether the registrar will sell now, and if not, why.
 * @param {Chain} chain
 * @param {BlockRef} [block]
 * @returns {Promise<{
 *   open: boolean, daiAboveFloor: boolean | null, daiRevert: string | null, beneficiary: string | null,
 *   beneficiaryRevert: string | null, reachable: { ethToR0: boolean, r0ToR1: boolean }
 * }>}
 */
export async function salesStatus (chain, block) {
  const probe = async (/** @type {string} */ to, /** @type {string} */ signature, /** @type {unknown[]} */ args, /** @type {string} */ output) => {
    try {
      return { value: (await readContract(chain, to, signature, args, [output], block))[0], revert: null }
    } catch (error) {
      if (error instanceof ChainError && (error.reason === 'reverted' || error.reason === 'badAnswer')) {
        return { value: null, revert: error.reason === 'reverted' ? error.message : 'unreadable' }
      }
      throw error
    }
  }
  const [floor, who, ethRegistry, r0] = await Promise.all([
    probe(ADDRESSES.registrar, 'daiAboveFloor()', [], 'bool'),
    probe(ADDRESSES.registrar, 'beneficiary()', [], 'address'),
    probe(ADDRESSES.ethRegistry, 'getSubregistry(string)', ['orivonid'], 'address'),
    probe(ADDRESSES.r0, 'getSubregistry(string)', ['v1'], 'address')
  ])
  const beneficiary = typeof who.value === 'string' ? nonZero(who.value) : null
  const reachable = {
    ethToR0: typeof ethRegistry.value === 'string' && sameAddress(ethRegistry.value, ADDRESSES.r0),
    r0ToR1: typeof r0.value === 'string' && sameAddress(r0.value, ADDRESSES.r1)
  }
  const daiAboveFloor = typeof floor.value === 'boolean' ? floor.value : null
  return {
    open: daiAboveFloor === true && beneficiary !== null && reachable.ethToR0 && reachable.r0ToR1,
    daiAboveFloor,
    daiRevert: floor.revert,
    beneficiary,
    beneficiaryRevert: beneficiary === null ? (who.revert ?? 'no beneficiary') : null,
    reachable
  }
}

/**
 * The holder of a label on R1 now, or null when nobody holds it.
 * @param {Chain} chain
 * @param {string} label
 * @param {BlockRef} [block]
 * @returns {Promise<string | null>}
 */
export async function ownerOf (chain, label, block) {
  const [owner] = await readContract(chain, ADDRESSES.r1, 'getOwner(uint256)', [labelId(label)], ['address'], block)
  return nonZero(/** @type {string} */ (owner))
}

/**
 * @typedef {object} Attribution Whether `address` owns `<label>.v1.orivonid.eth`; `ok` needs all four clauses.
 * @property {string} label
 * @property {string} address
 * @property {boolean} ok
 * @property {{ ok: boolean, owner: string | null }} owner (a) R1 names the address as the holder
 * @property {{ ok: boolean, roleCount: bigint, roles: bigint, problem: null | 'rolesUnreadable' }} roles (b) the address holds every
 *   role on the name and nobody else holds any; a read that reverts is `rolesUnreadable`, never zero
 * @property {{
 *   ok: boolean, resolver: string | null, address: string | null,
 *   problem: null | 'invalidLabel' | 'noResolver' | 'resolverFailed' | 'noAddress' | 'differentAddress'
 * }} forward (c) the name resolves to the address, through the resolver R1 names, on chain
 * @property {{ ok: boolean, resolver: string | null, problem: null | 'invalidLabel' | 'noResolver' | import('./permissions.js').RecordsProblem }} records
 *   (d) the address can write the name's records on that resolver (see permissions.js)
 */

/**
 * The attribution rule, read now. Another address's claim, a reverse record and a URL prove nothing.
 * @param {Chain} chain
 * @param {string} label
 * @param {string} address
 * @param {BlockRef} [block]
 * @returns {Promise<Attribution>}
 */
export async function attribution (chain, label, address, block) {
  if (!isAddress(address)) throw new TypeError('not an address')
  const who = toChecksumAddress(address)
  /** @type {Attribution} */
  const none = {
    label, address: who, ok: false,
    owner: { ok: false, owner: null }, roles: { ok: false, roleCount: 0n, roles: 0n, problem: null },
    forward: { ok: false, resolver: null, address: null, problem: 'invalidLabel' },
    records: { ok: false, resolver: null, problem: 'invalidLabel' }
  }
  if (!isValidLabel(label) || sameAddress(who, ZERO_ADDRESS)) return none
  const id = labelId(label)
  const r1 = ADDRESSES.r1
  const [ownerRead, countRead, rolesRead, resolverRead] = await Promise.all([
    orElse(readContract(chain, r1, 'getOwner(uint256)', [id], ['address'], block), [ZERO_ADDRESS]),
    orElse(readContract(chain, r1, 'roleCount(uint256)', [id], ['uint256'], block), null),
    orElse(readContract(chain, r1, 'roles(uint256,address)', [id, who], ['uint256'], block), null),
    orElse(readContract(chain, r1, 'getResolver(string)', [label], ['address'], block), [ZERO_ADDRESS])
  ])
  const owner = nonZero(/** @type {string} */ (ownerRead[0]))
  const roleCount = /** @type {bigint | undefined} */ (countRead?.[0])
  const roles = /** @type {bigint | undefined} */ (rolesRead?.[0])
  const resolver = nonZero(/** @type {string} */ (resolverRead[0]))
  const [forward, records] = await Promise.all([forwardResolution(chain, label, who, resolver, block), recordsClause(chain, resolver, who, block)])
  const clauses = {
    owner: { ok: owner !== null && sameAddress(owner, who), owner },
    roles: roleCount === undefined || roles === undefined
      ? { ok: false, roleCount: roleCount ?? 0n, roles: roles ?? 0n, problem: /** @type {const} */ ('rolesUnreadable') }
      : { ok: roleCount === roles, roleCount, roles, problem: null },
    forward,
    records
  }
  return { label, address: who, ...clauses, ok: clauses.owner.ok && clauses.roles.ok && forward.ok && records.ok }
}

/** @returns {Promise<Attribution['records']>} */
async function recordsClause (
  /** @type {Chain} */ chain, /** @type {string | null} */ resolver, /** @type {string} */ who, /** @type {BlockRef | undefined} */ block
) {
  if (resolver === null) return { ok: false, resolver, problem: 'noResolver' }
  const held = await recordsHeld(
    (to, signature, args, outputs) => readContract(chain, to, signature, args, outputs, block),
    { resolver, holder: who, factory: ADDRESSES.verifiableFactory, implementation: ADDRESSES.resolverImplementation }
  )
  return { ...held, resolver }
}

/** @returns {Promise<Attribution['forward']>} */
async function forwardResolution (
  /** @type {Chain} */ chain, /** @type {string} */ label, /** @type {string} */ who,
  /** @type {string | null} */ resolver, /** @type {BlockRef | undefined} */ block
) {
  if (resolver === null) return { ok: false, resolver, address: null, problem: 'noResolver' }
  const name = nameOf(label)
  try {
    const answer = await resolveWith(chain, resolver, name, encodeCall('addr(bytes32)', [namehash(name)]), block)
    const resolved = nonZero(/** @type {string} */ (decode(['address'], answer)[0]))
    if (resolved === null) return { ok: false, resolver, address: null, problem: 'noAddress' }
    return { ok: sameAddress(resolved, who), resolver, address: resolved, problem: sameAddress(resolved, who) ? null : 'differentAddress' }
  } catch (error) {
    if (error instanceof AbiError || (error instanceof ChainError && (error.reason === 'reverted' || error.reason === 'badAnswer'))) {
      return { ok: false, resolver, address: null, problem: 'resolverFailed' }
    }
    throw error
  }
}

/**
 * The records a name's own resolver answers. Nothing is verified here; `attribution` says whose they are.
 * @param {Chain} chain
 * @param {string} label
 * @param {string[]} keys text record keys to read
 * @param {BlockRef} [block]
 * @returns {Promise<RecordsRead>}
 */
export async function records (chain, label, keys, block) {
  if (!isValidLabel(label)) return emptyRecords(keys)
  const [resolverRead] = await readContract(chain, ADDRESSES.r1, 'getResolver(string)', [label], ['address'], block)
  const resolver = nonZero(/** @type {string} */ (resolverRead))
  return resolver === null ? emptyRecords(keys) : await recordsAt(chain, resolver, label, keys, block)
}

/** @typedef {{ resolver: string | null, addr: string | null, texts: Record<string, string | null>, contenthash: Uint8Array | null, failed: string[] }} RecordsRead */

/** @param {string[]} keys @returns {RecordsRead} */
const emptyRecords = (keys) => ({ resolver: null, addr: null, texts: Object.fromEntries(keys.map((key) => [key, null])), contenthash: null, failed: [] })

/**
 * The records one resolver answers for a name, whichever resolver the registry names for it: what `records` reads from
 * the registry's own, and what a page reads from a resolver it is about to point the name at. They are asked in one call
 * where the resolver or Multicall3 allows (`readProfiles`); a record the resolver fails is listed in `failed` and the
 * others are still read.
 * @param {Chain} chain
 * @param {string} resolver
 * @param {string} label
 * @param {string[]} keys text record keys to read
 * @param {BlockRef} [block]
 * @returns {Promise<RecordsRead>}
 */
export async function recordsAt (chain, resolver, label, keys, block) {
  const name = nameOf(label)
  const node = namehash(name)
  const out = { ...emptyRecords(keys), resolver }
  const asked = [
    { id: 'addr', call: encodeCall('addr(bytes32)', [node]), output: 'address' },
    { id: 'contenthash', call: encodeCall('contenthash(bytes32)', [node]), output: 'bytes' },
    ...keys.map((key) => ({ id: `text:${key}`, call: encodeCall('text(bytes32,string)', [node, key]), output: 'string' }))
  ]
  const answers = await readProfiles(chain, resolver, name, asked, block)
  const [addr, contenthash, ...values] = answers.map((answer, index) => {
    if (answer.ok) return answer.value
    out.failed.push(/** @type {NonNullable<(typeof asked)[number]>} */ (asked[index]).id)
    return null
  })
  out.addr = typeof addr === 'string' ? nonZero(addr) : null
  out.contenthash = contenthash instanceof Uint8Array && contenthash.length > 0 ? contenthash : null
  keys.forEach((key, index) => { out.texts[key] = typeof values[index] === 'string' && values[index] !== '' ? /** @type {string} */ (values[index]) : null })
  return out
}


/** @typedef {import('./scan.js').NamesCache} NamesCache */

/**
 * @typedef {object} Coverage What the scan of R1's logs could see, so a page can say what it could not.
 * @property {boolean} complete every log from R1's first block to the head has been read, now or on an earlier visit
 * @property {boolean} failed a range could not be read this time, so the newest events may be missing
 * @property {number} unnamed tokens sent to the address that the scan could not put a label to
 * @property {number} blocks how far back from the head the scan has read without a gap; 0 when it has read nothing
 */

/** @template T @param {T[]} items @param {number} limit @param {(item: T) => Promise<unknown>} work */
async function inParallel (items, limit, work) {
  const results = new Array(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(/** @type {T} */ (items[index]))
    }
  })
  await Promise.all(lanes)
  return results
}

/**
 * The usernames an address holds now. The logs and the labels in `known` name the candidates (registered to the address,
 * sent to it, or remembered by the caller); each is then read on chain, and kept while R1 still names the address as its
 * holder. Each carries its attribution: a name held but not fully attributed (no resolver set, say) is listed with
 * `ok: false` so a page can say why. A name in `known` that R1 no longer gives to the address comes back in `lapsed`.
 *
 * Inside Orivon the logs are read only for the last SCAN_WINDOW blocks, because a light client proves no older ones;
 * elsewhere they are read from R1's first block. A range that cannot be read does not fail the call: `coverage` says so.
 * @param {Chain} chain
 * @param {string} address
 * @param {{ cache?: NamesCache | null, block?: number, known?: readonly string[] }} [options] `cache` is what the last call returned
 * @returns {Promise<{
 *   names: { label: string, attribution: Attribution }[], lapsed: { label: string, attribution: Attribution }[],
 *   cache: NamesCache, coverage: Coverage
 * }>}
 */
export async function namesOf (chain, address, options = {}) {
  if (!isAddress(address)) throw new TypeError('not an address')
  const head = options.block ?? await chain.blockNumber()
  const known = [...new Set(options.known ?? [])].filter(isValidLabel)
  const { cache, failed } = await scanLogs(chain, address, options.cache, head, {
    registry: ADDRESSES.r1, first: FIRST_BLOCK, margin: REORG_MARGIN, windowed: chain.kind === 'orivon', named: [...RESERVED, ...known]
  })
  const candidates = [...new Set([...cache.held, ...known])].sort()
  const checked = /** @type {Attribution[]} */ (await inParallel(candidates, 4, (label) => attribution(chain, label, address)))
  const entry = (/** @type {Attribution} */ one) => ({ label: one.label, attribution: one })
  const firstBlock = cache.firstBlock ?? FIRST_BLOCK
  return {
    names: checked.filter((one) => one.owner.ok).map(entry),
    lapsed: checked.filter((one) => !one.owner.ok && known.includes(one.label)).map(entry),
    cache,
    coverage: {
      complete: !failed && firstBlock <= FIRST_BLOCK,
      failed,
      unnamed: cache.unnamed?.length ?? 0,
      blocks: cache.lastBlock >= firstBlock ? head - firstBlock + 1 : 0
    }
  }
}

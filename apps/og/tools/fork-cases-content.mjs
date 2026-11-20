// The cases of the fork run for the registry's own `content(bytes32)` slot: what the 2015 contract does with it when the name is
// transferred, disowned, reserved again or written by someone who does not hold it, that the selectors and argument lists of
// `og-registry-calls.js` are the contract's (each setter is sent as the decoder reads it, and must change what it says it changes), and
// what the resolver's own rule then says of the slot, the other setters and a call through a contract.
// Each case returns the name as a test vector (`vector`): the state the resolver read and every log of the name with the transaction
// behind it, in the shape of test/support/og-vectors.ts, so a case played here is held by the unit tests as the chain showed it.

import { decode, encodeCall, ZERO_ADDRESS } from '../site/sdk/abi.js'
import { fromHex } from '../site/sdk/bytes.js'
import { keyOf } from '../site/resolver/og-name.js'
import { decodeRegistryCall } from '../site/resolver/og-registry-calls.js'
import { CENSUS_KEYS, PROXY, REGISTRY, TOPICS } from '../site/resolver/og-pins.js'
import { slotAddress } from '../site/resolver/og-answer.js'
import { readName } from '../site/resolver/og-state.js'
import { SITE } from './fork-world.mjs'

const OWNER = `0x${'a1'.repeat(20)}`
const BUYER = `0x${'b2'.repeat(20)}`
const THIRD = `0x${'c3'.repeat(20)}`
/** A contract that calls the registry with whatever it is sent, as a Safe or a bundler does: planted on the fork at this address. */
const FORWARDER = `0x${'f0'.repeat(20)}`
const ZERO_WORD = `0x${'0'.repeat(64)}`
/** A digest the way a person's IPFS file gives one: the registry holds 32 bytes and says nothing of what they mean. */
const FIRST = `0x${'12'.repeat(32)}`
const SECOND = `0x${'34'.repeat(32)}`
const FIRST_RECORD = slotAddress(FIRST)
const SECOND_RECORD = slotAddress(SECOND)

/**
 * Runtime code that forwards its calldata to the registry and stops: CALLDATACOPY(0, 0, size); CALL(gas, registry, 0, 0, size, 0, 0).
 * The registry then sees the contract as its caller, and the transaction is to the contract.
 */
const FORWARDER_CODE = `0x36600060003760006000366000600073${REGISTRY.slice(2).toLowerCase()}5af15000`

/** @param {import('./fork-world.mjs').World} w @returns {import('./fork-world.mjs').Case[]} */
export default (w) => {
  const { ask, check, hexOf, quantity, register, resolverSays } = w
  const label = (/** @type {string} */ prefix) => `${prefix}${Date.now() % 1e6}`

  /** @type {any} */
  let chain = null
  /** One chain over the fork for every case: the resolver reads through the page's own adapter. */
  async function chainOfFork () {
    chain ??= (await register({ label: label('ogfkchain'), tip: false })).chain
    return chain
  }
  const says = async (/** @type {string} */ name) => await resolverSays(name, await chainOfFork())

  /** One transaction as an account the fork lets act without its key, with the transaction as the decoder reads it. @param {string} from @param {string} to @param {Uint8Array} data */
  async function send (from, to, data) {
    await ask('anvil_impersonateAccount', from)
    await ask('anvil_setBalance', from, quantity(10n ** 19n))
    const hash = /** @type {string} */ (await ask('eth_sendTransaction', { from, to, data: hexOf(data), gas: quantity(300_000n) }))
    /** @type {any} */
    let receipt = null
    for (let tries = 0; receipt === null && tries < 100; tries++) {
      receipt = await ask('eth_getTransactionReceipt', hash)
      if (receipt === null) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const tx = /** @type {any} */ (await ask('eth_getTransactionByHash', hash))
    const changed = receipt.logs.filter((/** @type {any} */ log) => log.topics[0] === TOPICS.changed && String(log.address).toLowerCase() === REGISTRY.toLowerCase())
    return { status: Number(receipt.status), changed: changed.length, names: changed.map((/** @type {any} */ log) => log.topics[1]), tx: { to: tx.to, input: fromHex(tx.input) } }
  }
  /** One call to the registry. @param {string} from @param {string} signature @param {unknown[]} args */
  const call = (from, signature, args) => send(from, REGISTRY, encodeCall(signature, args))

  /** @param {string} signature @param {string} key @param {string} type */
  const view = async (signature, key, type) => decode([type], fromHex(/** @type {string} */ (await ask('eth_call', { to: REGISTRY, data: hexOf(encodeCall(signature, [key])) }, 'latest')))).at(0)
  const contentOf = async (/** @type {string} */ key) => `0x${Buffer.from(/** @type {Uint8Array} */ (await view('content(bytes32)', key, 'bytes32'))).toString('hex')}`
  const ownerOf = async (/** @type {string} */ key) => String(await view('owner(bytes32)', key, 'address')).toLowerCase()

  /** A name `OWNER` holds with `FIRST` in its slot. @param {string} name */
  async function held (name) {
    const key = keyOf(name)
    await call(OWNER, 'reserve(bytes32)', [key])
    await call(OWNER, 'setContent(bytes32,bytes32)', [key, FIRST])
    check(await contentOf(key) === FIRST && await ownerOf(key) === OWNER, 'the owner reserved the name and set its content')
    return key
  }

  /**
   * The name as a test vector: what the resolver reads of it now, every log it has on the fork (the registry's and the resolver's) with the
   * transaction behind each registry log, and what the rule says. Blocks are moved to a short run after `at`, in their order.
   * @param {string} id @param {string} name @param {Awaited<ReturnType<typeof says>>} found @param {number} from the fork's block number before the case's first transaction
   */
  async function vectorOf (id, name, found, from) {
    const key = keyOf(name)
    const reads = await readName(await chainOfFork(), key, 'latest', CENSUS_KEYS)
    const logs = /** @type {any[]} */ (await ask('eth_getLogs', { fromBlock: quantity(BigInt(from + 1)), toBlock: 'latest', address: [REGISTRY, PROXY], topics: [null, key] }))
    const order = [...new Set(logs.map((log) => Number(log.blockNumber)))].sort((a, b) => a - b)
    const entries = []
    for (const log of logs) {
      const registry = String(log.address).toLowerCase() === REGISTRY.toLowerCase()
      const base = [registry ? 'registry' : 'proxy', 26_400_804 + order.indexOf(Number(log.blockNumber)), Number(log.logIndex), log.topics]
      if (!registry) { entries.push(base); continue }
      const tx = /** @type {any} */ (await ask('eth_getTransactionByHash', log.transactionHash))
      entries.push([...base, { ...(String(tx.to).toLowerCase() === REGISTRY.toLowerCase() ? {} : { to: tx.to }), input: tx.input }])
    }
    return {
      id, label: name,
      records: found.counted.filter((/** @type {string} */ one) => one !== 'contentcontract'),
      reasons: Object.fromEntries(Object.entries(found.reasons).filter(([one, reason]) => one !== 'contentcontract' && reason !== 'passes' && reason !== 'empty')),
      state: {
        registryOwner: reads.registryOwner, nameToId: String(reads.nameToId), idToName: reads.idToName ?? ZERO_WORD, ownerOf: reads.ownerOf, controller: reads.controller ?? ZERO_ADDRESS, registryContent: reads.registryContent,
        values: Object.fromEntries(Object.entries(reads.values).filter(([, value]) => value !== null && value !== ''))
      },
      registry: found.registry,
      logs: entries
    }
  }
  const blockNumber = async () => Number(BigInt(/** @type {string} */ (await ask('eth_blockNumber'))))

  return [
    {
      name: 'registry content: the owner sets it, a non-owner changes nothing, and the resolver counts the holder\'s value',
      async run () {
        const name = label('ogfkcs')
        const key = keyOf(name)
        const from = await blockNumber()
        const reserved = await call(OWNER, 'reserve(bytes32)', [key])
        const set = await call(OWNER, 'setContent(bytes32,bytes32)', [key, FIRST])
        check(await contentOf(key) === FIRST && set.changed === 1, 'setContent by the owner wrote the slot and logged Changed once', set)
        check(JSON.stringify(decodeRegistryCall(set.tx, key)) === JSON.stringify({ fn: 'setContent', value: FIRST }), 'the decoder reads the transaction as the call it was', set.tx)
        const foreign = await call(BUYER, 'setContent(bytes32,bytes32)', [key, SECOND])
        check(await contentOf(key) === FIRST && foreign.changed === 0, 'setContent by an account that does not hold the name changed nothing and logged nothing', foreign)
        const counted = await says(name)
        check(counted.registry?.counts === true && counted.records.length === 1 && counted.records[0].value === FIRST_RECORD, 'the holder\'s direct setContent counts, and answers as the CIDv1 of the digest', counted)
        const again = await call(OWNER, 'setContent(bytes32,bytes32)', [key, SECOND])
        check(await contentOf(key) === SECOND && again.changed === 1, 'the owner can write it again')
        const second = await says(name)
        check(second.records.length === 1 && second.records[0].value === SECOND_RECORD, 'the latest value is the one answered', second)
        const cleared = await call(OWNER, 'setContent(bytes32,bytes32)', [key, ZERO_WORD])
        check(await contentOf(key) === ZERO_WORD && cleared.changed === 1, 'writing zero clears it, and that is a log too')
        const empty = await says(name)
        check(empty.records.length === 0 && empty.registry?.reason === 'empty', 'a cleared slot answers nothing', empty)
        await call(OWNER, 'setContent(bytes32,bytes32)', [key, FIRST])
        const vector = await vectorOf('registry-content-set-by-holder', name, await says(name), from)
        return { reserveStatus: reserved.status, nonOwnerStatus: foreign.status, nonOwnerLogs: foreign.changed, nonOwnerLeftTheSlot: 'as it was', resolver: second, vector }
      }
    },
    {
      name: 'registry content: the other setters keep it and log Changed, and the holder\'s own setter does not end a text record',
      async run () {
        const name = label('ogfkst')
        const from = await blockNumber()
        const key = await held(name)
        const address = await call(OWNER, 'setAddress(bytes32,address,bool)', [key, THIRD, true])
        const registrar = await call(OWNER, 'setSubRegistrar(bytes32,address)', [key, THIRD])
        check(address.changed === 1 && registrar.changed === 1 && address.names[0] === key && registrar.names[0] === key, 'each setter logged Changed once, for the name in its first argument', { address, registrar })
        check(String(await view('addr(bytes32)', key, 'address')).toLowerCase() === THIRD, 'setAddress(bytes32,address,bool) set the address')
        check(await contentOf(key) === FIRST, 'neither setter touched the content')
        check(decodeRegistryCall(address.tx, key)?.fn === 'setAddress' && decodeRegistryCall(registrar.tx, key)?.fn === 'setSubRegistrar', 'the decoder reads both')
        const slot = await says(name)
        check(slot.registry?.counts === true && slot.records.length === 1, 'the slot still counts after both setters', slot)
        // A text record is held to the same reading: written, then the holder's own setter, then it still stands.
        await send(OWNER, PROXY, encodeCall('setController(bytes32,address)', [key, OWNER]))
        await send(OWNER, PROXY, encodeCall('setTextRecord(bytes32,string,string)', [key, SITE.key, SITE.text]))
        await call(OWNER, 'setAddress(bytes32,address,bool)', [key, BUYER, true])
        const both = await says(name)
        check(both.reasons[SITE.key] === 'passes' && both.records.length === 2 && both.records[0].value === SITE.text && both.records[1].value === FIRST_RECORD, 'a text record written before the holder\'s own setter counts, and is listed before the slot\'s record', both)
        const vector = await vectorOf('registry-setter-keeps-record', name, both, from)
        // The getter of the sub-registrar answers zero after the setter, so only the log and the status show the call took: said as it is.
        return { setAddress: 'sets addr(name), logs Changed once', setSubRegistrar: `logs Changed once; subRegistrar(name) then reads ${String(await view('subRegistrar(bytes32)', key, 'address')) === ZERO_ADDRESS ? 'zero' : 'the address'}`, resolver: both, vector }
      }
    },
    {
      name: 'registry content: after transfer the buyer holds a slot the seller wrote, and it does not count until the buyer writes it',
      async run () {
        const name = label('ogfkxf')
        const from = await blockNumber()
        const key = await held(name)
        const moved = await call(OWNER, 'transfer(bytes32,address)', [key, BUYER])
        check(await ownerOf(key) === BUYER && moved.changed === 1, 'the name changed hands and logged Changed once', moved)
        check(decodeRegistryCall(moved.tx, key)?.fn === 'transfer', 'the decoder reads the transfer')
        const kept = await contentOf(key)
        const outsider = await call(OWNER, 'setContent(bytes32,bytes32)', [key, SECOND])
        check(await contentOf(key) === kept && outsider.changed === 0, 'the seller can no longer write the slot')
        const leftover = await says(name)
        check(leftover.registry?.counts === false && leftover.registry.reason === 'registry-content-set-before-the-last-holder-change' && leftover.records.length === 0, 'the seller\'s value does not count for the buyer', leftover)
        const vector = await vectorOf('registry-content-sellers-leftover', name, leftover, from)
        await call(BUYER, 'setContent(bytes32,bytes32)', [key, FIRST])
        const rewritten = await says(name)
        check(rewritten.registry?.counts === true && rewritten.records.length === 1, 'the buyer writing the same digest again makes it count', rewritten)
        return { slotAfterTransfer: kept === FIRST ? 'kept: the buyer holds a slot the seller wrote' : kept === ZERO_WORD ? 'cleared' : kept, resolver: leftover, afterTheBuyersOwnWrite: rewritten, vector }
      }
    },
    {
      name: 'registry content: after disown, and after another account reserves the freed name',
      async run () {
        const name = label('ogfkdis')
        const from = await blockNumber()
        const key = await held(name)
        const gone = await call(OWNER, 'disown(bytes32)', [key])
        check(await ownerOf(key) === ZERO_ADDRESS && gone.changed === 1, 'the name is free and the disown logged Changed once', gone)
        check(decodeRegistryCall(gone.tx, key)?.fn === 'disown', 'the decoder reads the disown')
        const afterDisown = await contentOf(key)
        const taken = await call(BUYER, 'reserve(bytes32)', [key])
        check(await ownerOf(key) === BUYER && taken.changed === 1, 'another account reserved it')
        const afterReserve = await contentOf(key)
        const name2 = (/** @type {string} */ slot) => slot === FIRST ? 'kept the previous holder\'s value' : slot === ZERO_WORD ? 'empty' : slot
        const found = await says(name)
        check(afterReserve === ZERO_WORD ? found.registry?.reason === 'empty' && found.records.length === 0 : true, 'a slot the registry emptied answers nothing', found)
        const vector = await vectorOf('registry-content-after-disown', name, found, from)
        return { slotAfterDisown: name2(afterDisown), slotAfterReserve: name2(afterReserve), resolver: found, vector }
      }
    },
    {
      name: 'registry content: a value written through a contract does not count',
      async run () {
        const name = label('ogfkct')
        const key = keyOf(name)
        await ask('anvil_setCode', FORWARDER, FORWARDER_CODE)
        const from = await blockNumber()
        await call(OWNER, 'reserve(bytes32)', [key])
        await call(OWNER, 'transfer(bytes32,address)', [key, FORWARDER])
        check(await ownerOf(key) === FORWARDER.toLowerCase(), 'the contract holds the name')
        const through = await send(OWNER, FORWARDER, encodeCall('setContent(bytes32,bytes32)', [key, FIRST]))
        check(await contentOf(key) === FIRST && through.changed === 1 && through.tx.to?.toLowerCase() === FORWARDER, 'the contract wrote the slot as the holder, and the transaction is to the contract', through)
        check(decodeRegistryCall(through.tx, key) === null, 'the decoder reads no call of a transaction to a contract')
        const found = await says(name)
        check(found.registry?.counts === false && found.registry.reason === 'registry-content-no-setContent-log' && found.records.length === 0, 'a value written through a contract does not count', found)
        const vector = await vectorOf('registry-content-through-a-contract', name, found, from)
        return { resolver: found, vector }
      }
    }
  ]
}

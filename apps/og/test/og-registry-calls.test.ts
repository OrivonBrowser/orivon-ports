import { describe, expect, it } from 'vitest'
import { concat, fromHex, toHex } from '../site/sdk/bytes.js'
import { encodeCall, selector, toChecksumAddress } from '../site/sdk/abi.js'
import { keyOf } from '../site/resolver/og-name.js'
import { PROXY, REGISTRY, WRAPPER } from '../site/resolver/og-pins.js'
import { decodeRegistryCall, REGISTRY_CALLS, SETTERS } from '../site/resolver/og-registry-calls.js'

const KEY = keyOf('jsunblaze')
const OTHER = keyOf('aiagent')
const VALUE = '0xc452c1d588b1e9f01a272fee57ff9d29b22d163fbbb4fd8733f6e25a7dcbef34'
const PEER = toChecksumAddress(`0x${'ab'.repeat(20)}`)
const direct = (input: Uint8Array) => ({ to: REGISTRY, input })

/** What a call to each of the six looks like on chain, by the arguments each takes. */
const CALLS: [string, string, unknown[]][] = [
  ['setContent', 'setContent(bytes32,bytes32)', [KEY, VALUE]],
  ['setAddress', 'setAddress(bytes32,address,bool)', [KEY, PEER, true]],
  ['setSubRegistrar', 'setSubRegistrar(bytes32,address)', [KEY, PEER]],
  ['reserve', 'reserve(bytes32)', [KEY]],
  ['transfer', 'transfer(bytes32,address)', [KEY, PEER]],
  ['disown', 'disown(bytes32)', [KEY]]
]

describe('the registry\'s selectors', () => {
  it('are the four bytes of each call\'s signature, as the contract\'s own code dispatches them', () => {
    expect(REGISTRY_CALLS.map(([fn, signature]) => [fn, toHex(selector(signature))])).toEqual([
      ['setContent', 'c3d014d6'], ['setAddress', 'be99a980'], ['setSubRegistrar', '89a69c0e'], ['reserve', '432ced04'], ['transfer', '79ce9fac'], ['disown', 'd93e7573']
    ])
  })

  it('count three setters, and not the calls that start, move or end a name', () => {
    expect([...SETTERS].sort()).toEqual(['setAddress', 'setContent', 'setSubRegistrar'])
  })
})

describe('decodeRegistryCall', () => {
  it.each(CALLS)('reads a direct call of %s about the name', (fn, signature, args) => {
    const call = decodeRegistryCall(direct(encodeCall(signature, args)), KEY)
    expect(call).toEqual(fn === 'setContent' ? { fn, value: VALUE } : { fn })
  })

  it('gives the value a setContent wrote as lower-case hexadecimal, and takes the key in either case', () => {
    const upper = `0x${VALUE.slice(2).toUpperCase()}`
    expect(decodeRegistryCall(direct(encodeCall('setContent(bytes32,bytes32)', [KEY, upper])), KEY.toUpperCase().replace('0X', '0x'))).toEqual({ fn: 'setContent', value: VALUE })
  })

  it('takes the registry\'s address in either case', () => {
    expect(decodeRegistryCall({ to: REGISTRY.toLowerCase(), input: encodeCall('reserve(bytes32)', [KEY]) }, KEY)).toEqual({ fn: 'reserve' })
  })

  it('reads nothing of a transaction that is not to the registry: a contract call can do anything with the same input, a creation has no recipient', () => {
    const input = encodeCall('setContent(bytes32,bytes32)', [KEY, VALUE])
    for (const to of [WRAPPER, PROXY, PEER, null]) expect(decodeRegistryCall({ to, input }, KEY), String(to)).toBeNull()
  })

  it('reads nothing of a call about another name', () => {
    for (const [, signature, args] of CALLS) expect(decodeRegistryCall(direct(encodeCall(signature, [OTHER, ...args.slice(1)])), KEY), signature).toBeNull()
  })

  it('reads nothing of input shorter or longer than the call takes, so a call that would read zeros for the words it lacks is not taken for the full one', () => {
    for (const [, signature, args] of CALLS) {
      const input = encodeCall(signature, args)
      expect(decodeRegistryCall(direct(input.subarray(0, input.length - 1)), KEY), `${signature} one byte short`).toBeNull()
      expect(decodeRegistryCall(direct(input.subarray(0, 36)), KEY) === null, `${signature} cut after the name`).toBe(args.length > 1)
      expect(decodeRegistryCall(direct(concat(input, new Uint8Array(1))), KEY), `${signature} one byte over`).toBeNull()
      expect(decodeRegistryCall(direct(concat(input, new Uint8Array(32))), KEY), `${signature} one word over`).toBeNull()
    }
  })

  it('reads nothing of empty input, a selector alone, a selector the registry does not have, or garbage', () => {
    expect(decodeRegistryCall(direct(new Uint8Array(0)), KEY)).toBeNull()
    expect(decodeRegistryCall(direct(fromHex('c3d014d6')), KEY)).toBeNull()
    expect(decodeRegistryCall(direct(fromHex('c3d014')), KEY)).toBeNull()
    expect(decodeRegistryCall(direct(encodeCall('owner(bytes32)', [KEY])), KEY)).toBeNull()
    expect(decodeRegistryCall(direct(encodeCall('disown(bytes32,address)', [KEY, PEER])), KEY)).toBeNull()
    expect(decodeRegistryCall(direct(encodeCall('setAddress(bytes32,address)', [KEY, PEER])), KEY)).toBeNull()
    expect(decodeRegistryCall(direct(Uint8Array.from({ length: 68 }, (_, index) => (index * 37) % 251)), KEY)).toBeNull()
  })
})

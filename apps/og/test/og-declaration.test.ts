import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { selector } from '../site/sdk/abi.js'
import { toHex } from '../site/sdk/bytes.js'
import { IMPLEMENTATION, PROXY, REGISTRY, WRAPPER } from '../site/resolver/og-pins.js'
import { createWrapperTx, reserveTx, setControllerTx, setPrimaryTx, setTextTx, transferTx, unsetControllerTx, unsetPrimaryTx, unsetTextTx, unwrapTx, wrapTx } from '../site/register-tx.js'

// The `contracts` of the `og-names` entry, held to the closed list of shapes a name system may declare its calls with. Nothing here
// imports from Orivon: the rules are written out again from the shapes' own meaning, so a declaration that drifts from them fails here
// before an install refuses it. The code hashes are facts of the chain and are read there (README.md, section The contracts it declares).

type Json = Record<string, any>
const manifest = JSON.parse(await readFile(new URL('../orivon.json', import.meta.url), 'utf8'))
const entry: Json = manifest.integrations.find((one: Json) => one.id === 'og-names')
const contracts: Json[] = entry.contracts

const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const CANONICAL = /^[A-Za-z_][A-Za-z0-9_]*\((?:(?:address|bool|bytes|string|bytes32|uint256)(?:,(?:address|bool|bytes|string|bytes32|uint256))*)?\)$/
const typesOf = (signature: string): string[] => signature.slice(signature.indexOf('(') + 1, -1).split(',').filter((one) => one !== '')
const selectorOf = (signature: string): string => `0x${toHex(selector(signature))}`
const lower = (address: string): string => address.toLowerCase()

/** The ABI type each way of reading an argument needs. */
const NAME_TYPE: Record<string, string> = { 'label-bytes32': 'bytes32', 'dns-name': 'bytes', 'name-string': 'string' }
const VALUE_TYPE: Record<string, string> = { address: 'address', text: 'string', contenthash: 'bytes', bytes32: 'bytes32' }
const FIXED_TYPE: Record<string, string> = { key: 'string', account: 'address', token: 'uint256' }
const REF_TYPE: Record<string, string> = { key: 'string', signer: 'address', token: 'uint256' }
const NAME_KINDS = Object.keys(NAME_TYPE)
const VALUE_KINDS = Object.keys(VALUE_TYPE)

interface Shape { roles: string[], optionalKey?: boolean, now?: (value: string | undefined, hasKey: boolean) => { refs: string[], returns: string[] }, nameOf?: { refs: string[], returns: string[] } }

/** Design D5: the arguments each shape takes, and the read it needs. `value` is the kind the function's value argument is read as. */
const SHAPES: Record<string, Shape> = {
  'claim-name': { roles: ['name'], now: () => ({ refs: ['name'], returns: ['address'] }) },
  'give-name': { roles: ['name', 'account'], now: () => ({ refs: ['name'], returns: ['address'] }) },
  'set-record': { roles: ['name', 'value'], optionalKey: true, now: (value, hasKey) => ({ refs: hasKey ? ['name', 'key'] : ['name'], returns: [value ?? ''] }) },
  'clear-record': { roles: ['name'], optionalKey: true, now: (_value, hasKey) => ({ refs: hasKey ? ['name', 'key'] : ['name'], returns: VALUE_KINDS }) },
  'set-manager': { roles: ['name', 'account'], now: () => ({ refs: ['name'], returns: ['address'] }) },
  'clear-manager': { roles: ['name'], now: () => ({ refs: ['name'], returns: ['address'] }) },
  'set-primary': { roles: ['name'], now: () => ({ refs: ['signer'], returns: NAME_KINDS }) },
  'clear-primary': { roles: [], now: () => ({ refs: ['signer'], returns: NAME_KINDS }) },
  'prepare-wrap': { roles: ['name'] },
  wrap: { roles: ['name'] },
  unwrap: { roles: ['token'], nameOf: { refs: ['token'], returns: NAME_KINDS } }
}

/** Calls the wallet words itself or that forward or hand over authority: a declaration may claim none of them. */
const NOT_DECLARABLE = [
  'transfer(address,uint256)', 'transferFrom(address,address,uint256)', 'approve(address,uint256)', 'setApprovalForAll(address,bool)',
  'safeTransferFrom(address,address,uint256)', 'safeTransferFrom(address,address,uint256,bytes)', 'balanceOf(address)', 'allowance(address,address)',
  'multicall(bytes[])', 'execute(bytes)', 'upgradeTo(address)', 'upgradeToAndCall(address,bytes)', 'transferOwnership(address)',
  'renounceOwnership()', 'grantRole(bytes32,address)', 'revokeRole(bytes32,address)', 'setContenthash(bytes32,bytes)'
]

const functions = contracts.flatMap((contract, at) => contract.functions.map((declared: Json) => ({ contract, at, declared })))

function argTypes (declared: Json): Map<string, { type: string, as?: string }> {
  const types = typesOf(declared.signature)
  expect(declared.args, declared.signature).toHaveLength(types.length)
  const roles = new Map<string, { type: string, as?: string }>()
  declared.args.forEach((arg: Json, index: number) => {
    expect(roles.has(arg.role), `${declared.signature} uses ${arg.role} twice`).toBe(false)
    const expected = arg.role === 'name' ? NAME_TYPE[arg.as] : arg.role === 'value' ? VALUE_TYPE[arg.as] : FIXED_TYPE[arg.role]
    expect(expected, `${declared.signature} argument ${index} has no readable part`).toBeDefined()
    expect(types[index], `${declared.signature} argument ${index} as ${arg.role}`).toBe(expected)
    expect(Object.keys(arg).filter((key) => key !== 'role' && !(key === 'as' && (arg.role === 'name' || arg.role === 'value')))).toEqual([])
    roles.set(arg.role, { type: expected as string, ...(arg.as === undefined ? {} : { as: arg.as as string }) })
  })
  return roles
}

function checkRead (read: Json, rule: { refs: string[], returns: string[] }, roles: Map<string, { type: string }>, who: string): void {
  expect(Object.keys(read).sort(), who).toEqual(['args', 'returns', 'signature'])
  expect(read.signature, who).toMatch(CANONICAL)
  const types = typesOf(read.signature)
  expect(read.args, who).toHaveLength(types.length)
  expect(new Set(read.args).size, who).toBe(read.args.length)
  expect([...read.args].sort(), who).toEqual([...rule.refs].sort())
  read.args.forEach((ref: string, index: number) => {
    expect(types[index], `${who}: ${ref}`).toBe(ref === 'name' ? roles.get('name')?.type : REF_TYPE[ref])
  })
  expect(rule.returns, who).toContain(read.returns)
}

describe('the og-names declaration of its contracts', () => {
  it('is a list of at most 4 contracts on Ethereum, each with at most 16 functions, in the namespace the integration serves', () => {
    expect(Array.isArray(contracts)).toBe(true)
    expect(contracts.length).toBeGreaterThan(0)
    expect(contracts.length).toBeLessThanOrEqual(4)
    for (const contract of contracts) {
      expect(Object.keys(contract).filter((key) => !['chainId', 'address', 'codeHash', 'implementation', 'namespace', 'functions'].includes(key))).toEqual([])
      expect(contract.chainId).toBe(1)
      expect(entry.namespaces).toContain(contract.namespace)
      expect(contract.namespace).not.toBe('*')
      expect(contract.namespace).toMatch(/^\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/)
      expect(contract.functions.length).toBeGreaterThan(0)
      expect(contract.functions.length).toBeLessThanOrEqual(16)
    }
  })

  it('writes every address and hash as 0x and lower-case hexadecimal digits, and declares no contract twice', () => {
    const seen = new Set<string>()
    for (const contract of contracts) {
      expect(contract.address).toMatch(ADDRESS)
      expect(contract.codeHash).toMatch(HASH)
      expect(seen.has(contract.address)).toBe(false)
      seen.add(contract.address)
      if (contract.implementation === undefined) continue
      expect(Object.keys(contract.implementation).sort()).toEqual(['address', 'codeHash'])
      expect(contract.implementation.address).toMatch(ADDRESS)
      expect(contract.implementation.codeHash).toMatch(HASH)
      expect(contract.implementation.address).not.toBe(contract.address)
    }
  })

  it('declares the three Linagee contracts the page already holds, the resolver behind its proxy and the wrapper', () => {
    expect(contracts.map((contract) => contract.address)).toEqual([lower(REGISTRY), lower(PROXY), lower(WRAPPER)])
    expect(contracts[1]!.implementation.address).toBe(lower(IMPLEMENTATION))
    expect(contracts[0]!.implementation).toBeUndefined()
    expect(contracts[2]!.implementation).toBeUndefined()
  })

  it('gives each function a canonical signature, a shape of the closed list and the arguments that shape takes', () => {
    for (const { declared } of functions) {
      expect(Object.keys(declared).filter((key) => !['signature', 'shape', 'args', 'now', 'nameOf'].includes(key)), declared.signature).toEqual([])
      expect(declared.signature).toMatch(CANONICAL)
      expect(Object.hasOwn(SHAPES, declared.shape), `${declared.signature}: ${declared.shape}`).toBe(true)
      const shape = SHAPES[declared.shape] as Shape
      const roles = argTypes(declared)
      const takes = [...shape.roles, ...(shape.optionalKey === true ? ['key'] : [])]
      expect(shape.roles.filter((role) => !roles.has(role)), `${declared.signature} lacks a part its shape needs`).toEqual([])
      expect([...roles.keys()].filter((role) => !takes.includes(role)), `${declared.signature} has a part its shape does not take`).toEqual([])
    }
  })

  it('reads every name as a label in a bytes32, the way Linagee keys its names', () => {
    for (const { declared } of functions) {
      for (const arg of declared.args) if (arg.role === 'name') expect(arg).toEqual({ role: 'name', as: 'label-bytes32' })
      for (const read of [declared.now, declared.nameOf]) if (read !== undefined && NAME_KINDS.includes(read.returns)) expect(read.returns).toBe('label-bytes32')
    }
  })

  it('gives each function the read its shape needs, and no other, over the arguments and types the shape fixes', () => {
    for (const { declared } of functions) {
      const shape = SHAPES[declared.shape] as Shape
      const roles = argTypes(declared)
      const rule = shape.now?.(roles.get('value')?.as, roles.has('key'))
      expect(declared.now === undefined, `${declared.signature}: now`).toBe(rule === undefined)
      expect(declared.nameOf === undefined, `${declared.signature}: nameOf`).toBe(shape.nameOf === undefined)
      if (rule !== undefined) checkRead(declared.now, rule, roles, `${declared.signature} now`)
      if (shape.nameOf !== undefined) checkRead(declared.nameOf, shape.nameOf, roles, `${declared.signature} nameOf`)
    }
  })

  it('claims no function twice in a contract, none the wallet reads or words itself, and none of the wrapper\'s ERC-721 functions', () => {
    const forbidden = new Set(NOT_DECLARABLE.map(selectorOf))
    for (const contract of contracts) {
      const seen = new Set<string>()
      for (const declared of contract.functions) {
        const one = selectorOf(declared.signature)
        expect(forbidden.has(one), `${declared.signature} is a function the wallet words itself`).toBe(false)
        expect(seen.has(one), `${declared.signature} twice`).toBe(false)
        seen.add(one)
      }
    }
    const wrapper = contracts[2]!.functions.map((declared: Json) => declared.signature)
    expect(wrapper).toEqual(['createWrapper(bytes32)', 'wrap(bytes32)', 'unwrap(uint256)'])
  })

  it('declares each call as the page itself encodes it, so a call the page sends reads as the declaration says', () => {
    const key = `0x${'ab'.repeat(32)}`
    const account = `0x${'12'.repeat(20)}`
    const sent: Record<string, { to: string, data: Uint8Array }> = {
      'reserve(bytes32)': reserveTx(key),
      'transfer(bytes32,address)': transferTx(key, account),
      'setTextRecord(bytes32,string,string)': setTextTx(key, 'content.ipfs', 'ipfs://x'),
      'unsetTextRecord(bytes32,string)': unsetTextTx(key, 'content.ipfs'),
      'setController(bytes32,address)': setControllerTx(key, account),
      'unsetController(bytes32)': unsetControllerTx(key),
      'setPrimary(bytes32)': setPrimaryTx(key),
      'unsetPrimary()': unsetPrimaryTx(),
      'createWrapper(bytes32)': createWrapperTx(key),
      'wrap(bytes32)': wrapTx(key),
      'unwrap(uint256)': unwrapTx(7)
    }
    expect(functions.map(({ declared }) => declared.signature).sort()).toEqual(Object.keys(sent).sort())
    for (const { contract, declared } of functions) {
      const call = sent[declared.signature] as { to: string, data: Uint8Array }
      expect(lower(call.to), declared.signature).toBe(contract.address)
      expect(`0x${toHex(call.data.slice(0, 4))}`, declared.signature).toBe(selectorOf(declared.signature))
    }
  })

  it('computes the selectors of the functions the contracts are known by', () => {
    expect(selectorOf('transfer(address,uint256)')).toBe('0xa9059cbb')
    expect(selectorOf('setTextRecord(bytes32,string,string)')).toBe('0xad98b5e2')
  })
})

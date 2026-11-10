import { describe, expect, it } from 'vitest'
import { encodeCall } from '../site/sdk/abi.js'
import { fromHex, toHex } from '../site/sdk/bytes.js'
import { ADDRESSES } from '../site/sdk/orivonid.js'
import {
  approveTx, commitTx, deployResolverTx, ERC1155_ACCEPTED, initializeData, makeCommitment, MAX_COMMITMENT_AGE, MIN_COMMITMENT_AGE, RECORD_ROLES,
  recordCalls, recordsTx, receiverCheck, registerTx, RESOLVER_ROLES, ROLE_SET_RESOLVER, SALT, setResolverTx, withMargin
} from '../site/register-tx.js'
import * as v from './support/vectors.ts'

const hex = (bytes: Uint8Array) => '0x' + toHex(bytes)

describe('the constants', () => {
  it('has the resolver salt the plan names', () => {
    expect('0x' + SALT.toString(16)).toBe(v.SALT)
  })

  it('grants every role at the root, and needs the address and text roles of it', () => {
    expect(RESOLVER_ROLES).toBe(BigInt('0x' + '1'.repeat(64)))
    expect(RECORD_ROLES).toBe(0x11n)
    expect(RESOLVER_ROLES & RECORD_ROLES).toBe(RECORD_ROLES)
  })

  it('names R1\'s right to change a resolver by the bit the registrar gives a buyer', () => {
    expect(ROLE_SET_RESOLVER).toBe(1n << 24n)
  })

  it('has the registrar\'s commitment window', () => {
    expect([MIN_COMMITMENT_AGE, MAX_COMMITMENT_AGE]).toEqual([60, 86400])
  })
})

describe('the builders match cast calldata', () => {
  it('makeCommitment is keccak256 of abi.encode(label, owner, resolver, secret)', () => {
    expect(makeCommitment('alice', v.USER, v.RESOLVER, v.REVEAL_WORD)).toBe(v.COMMITMENT)
  })

  it('commit', () => {
    const tx = commitTx(v.COMMITMENT)
    expect(tx.to).toBe(ADDRESSES.registrar)
    expect(hex(tx.data)).toBe(v.COMMIT)
  })

  it('approve the registrar for the price', () => {
    const tx = approveTx(10n * 10n ** 18n)
    expect(tx.to).toBe(ADDRESSES.dai)
    expect(hex(tx.data)).toBe(v.APPROVE_10)
  })

  it('initialize gives the owner every role and sets no record', () => {
    expect(hex(initializeData(v.USER))).toBe(v.INITIALIZE)
  })

  it('deployProxy of the PermissionedResolver at the fixed salt', () => {
    const tx = deployResolverTx(v.USER)
    expect(tx.to).toBe(ADDRESSES.verifiableFactory)
    expect(hex(tx.data)).toBe(v.DEPLOY)
  })

  it('names no label anywhere in the deploy', () => {
    const bytes = deployResolverTx(v.USER).data
    for (const label of ['alice', 'orivon']) expect(new TextDecoder('latin1').decode(bytes)).not.toContain(label)
  })

  it('register', () => {
    const tx = registerTx('alice', v.USER, v.RESOLVER, v.REVEAL_WORD)
    expect(tx.to).toBe(ADDRESSES.registrar)
    expect(hex(tx.data)).toBe(v.REGISTER)
  })

  it('setAddress for coin type 60, and setText, as the resolver\'s own calls', () => {
    const [setAddress, setText] = recordCalls('alice', v.USER, { url: 'https://alice.example' })
    expect(hex(setAddress as Uint8Array)).toBe(v.SET_ADDRESS)
    expect(hex(setText as Uint8Array)).toBe(v.SET_TEXT)
  })

  it('the records go in one multicall: the address alone, or with texts in the order given', () => {
    expect(hex(recordsTx(v.RESOLVER, 'alice', v.USER).data)).toBe(v.MULTICALL_ONE)
    const tx = recordsTx(v.RESOLVER, 'alice', v.USER, { url: 'https://alice.example' })
    expect(tx.to).toBe(v.RESOLVER)
    expect(hex(tx.data)).toBe(v.MULTICALL_TWO)
  })

  it('the contenthash goes between the address and the texts, as the resolver\'s own call', () => {
    const calls = recordCalls('alice', v.USER, { url: 'https://alice.example' }, fromHex(v.CONTENTHASH))
    expect(calls.map(hex)).toEqual([v.SET_ADDRESS, v.SET_CONTENTHASH, v.SET_TEXT])
    expect(hex(recordsTx(v.RESOLVER, 'alice', v.USER, { url: 'https://alice.example' }, fromHex(v.CONTENTHASH)).data)).toBe(v.MULTICALL_HASH)
    expect(recordCalls('alice', v.USER, {}, null)).toHaveLength(1)
  })

  it('setResolver names the label by its id and goes to R1', () => {
    const tx = setResolverTx('alice', v.RESOLVER)
    expect(tx.to).toBe(ADDRESSES.r1)
    expect(hex(tx.data)).toBe(v.SET_RESOLVER)
  })

  it('the receiver check is the hook R1\'s mint calls, from R1, with the registrar as operator', () => {
    const check = receiverCheck(v.USER, 'alice')
    expect(check.from).toBe(ADDRESSES.r1)
    expect(check.to).toBe(v.USER)
    expect(hex(check.data)).toBe(v.RECEIVED)
    expect(toHex(check.data.subarray(0, 4))).toBe(ERC1155_ACCEPTED)
  })
})

describe('what a builder refuses', () => {
  it('a commitment that is not 32 bytes, an address that is not one, a negative amount', () => {
    expect(() => commitTx('0x1234')).toThrow()
    expect(() => registerTx('alice', '0x1234', v.RESOLVER, v.REVEAL_WORD)).toThrow()
    expect(() => approveTx(-1n)).toThrow()
    expect(() => recordsTx(v.RESOLVER, 'alice', 'nope')).toThrow()
  })

  it('encodes the same call the generic encoder does', () => {
    expect(hex(commitTx(v.COMMITMENT).data)).toBe(hex(encodeCall('commit(bytes32)', [v.COMMITMENT])))
  })
})

describe('the gas margin', () => {
  it('adds a quarter and rounds up', () => {
    expect(withMargin(100_000)).toBe(125_000)
    expect(withMargin(100_001)).toBe(125_002)
    expect(withMargin(100, 110)).toBe(110)
  })
})

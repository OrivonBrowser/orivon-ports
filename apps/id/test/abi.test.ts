import { describe, expect, it } from 'vitest'
import {
  AbiError, decode, decodeLog, decodeRevert, encode, encodeCall, isAddress, parseEvent, sameAddress, selector, splitSignature,
  toChecksumAddress, topic0
} from '../site/sdk/abi.js'
import { fromHex, toHex } from '../site/sdk/bytes.js'

// Every expected value below was produced by Foundry's cast (calldata, abi-encode, sig, sig-event).
const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const SAFE = '0x13C71e5404E7741008Bbf8F4CA177f3EbbB3F356'
const ZERO = '0x0000000000000000000000000000000000000000'
const ONE = '0x0000000000000000000000000000000000000000000000000000000000000001'

const hex = (bytes: Uint8Array) => '0x' + toHex(bytes)

const MAKE_COMMITMENT = '0x4455722f000000000000000000000000000000000000000000000000000000000000008000000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000005616c696365000000000000000000000000000000000000000000000000000000'
const DEPLOY_PROXY = '0x5d84121a000000000000000000000000565b0f456a04ac9b48758190e90030623cff57c5000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000004deadbeef00000000000000000000000000000000000000000000000000000000'
const INITIALIZE = '0x33cc44a0000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000000200000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8000000000000000000000000000000000000000000000000000000000000000100000000000000000000000013c71e5404e7741008bbf8f4ca177f3ebbb3f35600000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000000010100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000202030000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
const SET_TEXT = '0xc7279f88000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000000110b6f7269766f6e737461636b0365746800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001d6574682e6f7269766f6e737461636b2e69642e6e6f742d6265666f7265000000000000000000000000000000000000000000000000000000000000000000000a3137303030303030303000000000000000000000000000000000000000000000'
const MIXED = '0x00000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000ff000000000000000000000000000000000000000000000000000000000000000668c3a96c6c6f0000000000000000000000000000000000000000000000000000'
const NESTED = '0x00000000000000000000000000000000000000000000000000000000000000409061b9230000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000161000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'

describe('selectors and topics', () => {
  it('match cast sig and cast sig-event', () => {
    expect(hex(selector('deployProxy(address,uint256,bytes)'))).toBe('0x5d84121a')
    expect(hex(selector('supportsInterface(bytes4)'))).toBe('0x01ffc9a7')
    expect(topic0('LabelRegistered(uint256,bytes32,string,address,uint64,address)')).toBe('0x2fe093918572373e9f1f0368f414dffd0043a74ae8c9fd7b0e390b26a0d20b6e')
    expect(topic0('TransferSingle(address,address,address,uint256,uint256)')).toBe('0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62')
    expect(topic0('TransferBatch(address,address,address,uint256[],uint256[])')).toBe('0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb')
  })

  it('splits a signature at the top level only', () => {
    expect(splitSignature('initialize((address,uint256)[],bytes[])')).toEqual({ name: 'initialize', types: ['(address,uint256)[]', 'bytes[]'] })
    expect(splitSignature('owner()')).toEqual({ name: 'owner', types: [] })
    expect(() => splitSignature('nonsense')).toThrow(AbiError)
  })
})

describe('encoding', () => {
  it('encodes the registrar commitment call', () => {
    expect(hex(encodeCall('makeCommitment(string,address,address,bytes32)', ['alice', ALICE, ZERO, ONE]))).toBe(MAKE_COMMITMENT)
  })

  it('encodes bytes with an address, a number and a hex string', () => {
    expect(hex(encodeCall('deployProxy(address,uint256,bytes)', ['0x565b0F456a04Ac9b48758190e90030623Cff57C5', 1, '0xdeadbeef']))).toBe(DEPLOY_PROXY)
    expect(hex(encodeCall('deployProxy(address,uint256,bytes)', ['0x565b0F456a04Ac9b48758190e90030623Cff57C5', 1n, fromHex('deadbeef')]))).toBe(DEPLOY_PROXY)
  })

  it('encodes a tuple array beside a bytes array, the resolver initialisation', () => {
    const grants = [[ALICE, 1n], [SAFE, 1n << 128n]]
    expect(hex(encodeCall('initialize((address,uint256)[],bytes[])', [grants, ['0x01', '0x0203', '0x']]))).toBe(INITIALIZE)
  })

  it('encodes three dynamic arguments', () => {
    expect(hex(encodeCall('setText(bytes,string,string)', ['0x0b6f7269766f6e737461636b0365746800', 'eth.orivonstack.id.not-before', '1700000000']))).toBe(SET_TEXT)
  })

  it('encodes non-ASCII text by its UTF-8 bytes, and a static and a dynamic argument together', () => {
    expect(hex(encode(['string', 'bytes32', 'bool', 'uint8'], ['héllo', ONE, true, 255]))).toBe(MIXED)
  })

  it('encodes a dynamic tuple inside an array, with empty members', () => {
    expect(hex(encode(['(string,uint256[])[]', 'bytes4'], [[['a', [1n, 2n]], ['', []]], '0x9061b923']))).toBe(NESTED)
  })

  it('refuses what it cannot encode exactly', () => {
    expect(() => encode(['address'], ['0x70997970C51812dc3A010C7d01b50e0d17dc79c8'])).toThrow('not an address')
    expect(() => encode(['address'], ['0x1234'])).toThrow('not an address')
    expect(() => encode(['uint8'], [256])).toThrow('uint8')
    expect(() => encode(['uint256'], [-1n])).toThrow('uint256')
    expect(() => encode(['uint256'], [1.5])).toThrow(AbiError)
    expect(() => encode(['bytes32'], ['0x1234'])).toThrow('32 bytes')
    expect(() => encode(['bool'], [1])).toThrow('bool')
    expect(() => encode(['string'], [new Uint8Array(1)])).toThrow('string')
    expect(() => encode(['uint256', 'uint256'], [1n])).toThrow('2 types')
  })

  it('refuses types the site does not use, rather than approximating them', () => {
    for (const type of ['int256', 'uint7', 'uint264', 'bytes33', 'uint256[2]', 'function', 'tuple', 'bytes0']) {
      expect(() => encode([type], [0n]), type).toThrow(AbiError)
    }
  })
})

describe('decoding', () => {
  it('reads what it wrote', () => {
    expect(decode(['string', 'bytes32', 'bool', 'uint8'], fromHex(MIXED))).toEqual(['héllo', fromHex(ONE), true, 255n])
    const [grants, calls] = decode(['(address,uint256)[]', 'bytes[]'], fromHex(INITIALIZE).subarray(4)) as [[string, bigint][], Uint8Array[]]
    expect(grants).toEqual([[ALICE, 1n], [SAFE, 1n << 128n]])
    expect(calls.map(hex)).toEqual(['0x01', '0x0203', '0x'])
    expect(decode(['(string,uint256[])[]', 'bytes4'], fromHex(NESTED))).toEqual([[['a', [1n, 2n]], ['', []]], fromHex('9061b923')])
  })

  it('answers addresses in EIP-55 case', () => {
    expect(decode(['address'], fromHex('00'.repeat(12) + '13c71e5404e7741008bbf8f4ca177f3ebbb3f356'))).toEqual([SAFE])
  })

  it('refuses an answer that does not fit its own layout', () => {
    const word = (hexDigits: string) => fromHex(hexDigits.padStart(64, '0'))
    expect(() => decode(['uint256'], new Uint8Array(31))).toThrow('shorter')
    expect(() => decode(['bool'], word('2'))).toThrow('bool')
    expect(() => decode(['address'], fromHex('01' + '00'.repeat(31)))).toThrow('high bytes')
    expect(() => decode(['uint8'], word('100'))).toThrow('uint8')
    expect(() => decode(['bytes4'], fromHex('00'.repeat(5) + '01' + '00'.repeat(26)))).toThrow('padding')
    expect(() => decode(['bytes'], word('20'))).toThrow(AbiError)
    expect(() => decode(['bytes'], new Uint8Array([...word('20'), ...word('ffff')]))).toThrow('past the answer')
    expect(() => decode(['string'], new Uint8Array([...word('20'), ...word('1'), ...fromHex('ff' + '00'.repeat(31))]))).toThrow('UTF-8')
    expect(() => decode(['uint256[]'], new Uint8Array([...word('20'), ...word('7fffffff')]))).toThrow(AbiError)
  })

  it('does not allocate for a length it cannot back', () => {
    const word = (hexDigits: string) => fromHex(hexDigits.padStart(64, '0'))
    expect(() => decode(['bytes[]'], new Uint8Array([...word('20'), ...word('10')]))).toThrow(AbiError)
  })
})

describe('revert data', () => {
  it('reads Error(string), Panic(uint256), a custom error, and nothing', () => {
    expect(decodeRevert(fromHex('08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000e6e6f2062656e6566696369617279000000000000000000000000000000000000'))).toEqual({ kind: 'reason', reason: 'no beneficiary' })
    expect(decodeRevert(fromHex('4e487b710000000000000000000000000000000000000000000000000000000000000011'))).toEqual({ kind: 'panic', code: 17n })
    expect(decodeRevert(fromHex('556f1830aa'))).toEqual({ kind: 'custom', selector: '0x556f1830', data: fromHex('aa') })
    expect(decodeRevert(fromHex('08c379a0ff'))).toMatchObject({ kind: 'custom', selector: '0x08c379a0' })
    expect(decodeRevert(new Uint8Array(0))).toEqual({ kind: 'empty' })
  })
})

describe('events', () => {
  // The LabelRegistered log R1 emitted when the Safe reserved "orivon" (mainnet block 26357113, log 0x35).
  const registered = {
    topics: [
      '0x2fe093918572373e9f1f0368f414dffd0043a74ae8c9fd7b0e390b26a0d20b6e',
      '0x5647e4d60b64b58da57fd01194be016e5e7bfaaf6a23c21c5e62242c00000000',
      '0x5647e4d60b64b58da57fd01194be016e5e7bfaaf6a23c21c5e62242c1da25ef2',
      '0x00000000000000000000000013c71e5404e7741008bbf8f4ca177f3ebbb3f356'
    ],
    data: fromHex('000000000000000000000000000000000000000000000000000000000000006000000000000000000000000013c71e5404e7741008bbf8f4ca177f3ebbb3f356000000000000000000000000000000000000000000000000ffffffffffffffff00000000000000000000000000000000000000000000000000000000000000066f7269766f6e0000000000000000000000000000000000000000000000000000')
  }
  const event = parseEvent('LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)')

  it('takes its topic from the types alone', () => {
    expect(event.topic).toBe(registered.topics[0])
    expect(event.inputs.map((input) => input.indexed)).toEqual([true, true, false, false, false, true])
  })

  it('decodes a real log by field name', () => {
    const fields = decodeLog(event, registered)
    expect(fields['label']).toBe('orivon')
    expect(fields['owner']).toBe(SAFE)
    expect(fields['sender']).toBe(SAFE)
    expect(fields['expiry']).toBe(2n ** 64n - 1n)
    expect(hex(fields['labelHash'] as Uint8Array)).toBe(registered.topics[2])
    expect(fields['tokenId']).toBe(BigInt(registered.topics[1] as string))
  })

  it('refuses a log of another event or another shape', () => {
    expect(() => decodeLog(event, { ...registered, topics: registered.topics.slice(0, 3) })).toThrow('not a LabelRegistered log')
    expect(() => decodeLog(event, { ...registered, topics: ['0x' + '00'.repeat(32), ...registered.topics.slice(1)] })).toThrow(AbiError)
  })
})

describe('addresses', () => {
  it('checksums as EIP-55 does', () => {
    expect(toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')
    expect(toChecksumAddress('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359')).toBe('0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359')
    expect(toChecksumAddress(SAFE.toLowerCase())).toBe(SAFE)
  })

  it('accepts one case or the right mixed case, and nothing else', () => {
    expect(isAddress(SAFE)).toBe(true)
    expect(isAddress(SAFE.toLowerCase())).toBe(true)
    expect(isAddress('0x' + SAFE.slice(2).toUpperCase())).toBe(true)
    expect(isAddress('0x13C71e5404E7741008Bbf8F4CA177f3EbbB3F357')).toBe(false)
    expect(isAddress('0x13C71e5404E7741008Bbf8F4CA177f3EbbB3F3')).toBe(false)
    expect(isAddress(null)).toBe(false)
    expect(sameAddress(SAFE, SAFE.toLowerCase())).toBe(true)
  })
})

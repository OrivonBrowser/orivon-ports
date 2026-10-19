import { describe, expect, it } from 'vitest'
import { fromBase64 } from '../site/bytes.js'
import { expiry, parseRecord, publicKeyOfName, valueCid, verifyRecord } from '../site/ipns.js'

// explore.orivonstack.eth's IPNS record, as a gateway serves it (application/vnd.ipfs.ipns-record).
const KEY = 'k51qzi5uqu5dlswot3wcjo7k3vy02gepnrdw2qhu2a3f6ll422kykyoljjshuv'
const OTHER_KEY = 'k51qzi5uqu5dmhqqwks2m6pev89dabyb0yaanc12w0w3v2kccp9b8jiwa038zv'
const RECORD = 'CkEvaXBmcy9iYWZ5YmVpZ282YmdmY3ZyMmx4ZHQ3NHVkejI3bWxweWh3NWpuZ3Jxcmo2dnNxcGhxdnZuNmU2Y2dpbRJAfj2sqlPU7flXvY7yIQKywt2zZbQJq5R0ChHIpAU5DQVAYjZkRPtrbvsJx7UmiGRXfSA2jNnVu+1RTs7jmxAvCBgAIh4yMDI2LTEwLTIxVDEzOjQyOjUxLjk5MDU4MjAzNVooEDCA8JLL3QhCQKTWd4dY/OTMQAhO3K/RcObGiCRoLnrxEKL7ZtG+1JYI58WqUQr6rWcS2I4TgUg2AK/NlPQ/jzTsNtW1pNCWrgJKmAGlY1RUTBsAAABF2WS4AGVWYWx1ZVhBL2lwZnMvYmFmeWJlaWdvNmJnZmN2cjJseGR0NzR1ZHoyN21scHlodzVqbmdycXJqNnZzcXBocXZ2bjZlNmNnaW1oU2VxdWVuY2UQaFZhbGlkaXR5WB4yMDI2LTEwLTIxVDEzOjQyOjUxLjk5MDU4MjAzNVpsVmFsaWRpdHlUeXBlAA=='

const bytes = () => fromBase64(RECORD)

describe('parsing a real record', () => {
  const record = parseRecord(bytes())

  it('reads the signed Data: value, sequence, validity', () => {
    expect(record.value).toBe('/ipfs/bafybeigo6bgfcvr2lxdt74udz27mlpyhw5jngrqrj6vsqphqvvn6e6cgim')
    expect(record.sequence).toBe(16)
    expect(record.validity).toBe('2026-10-21T13:42:51.990582035Z')
    expect(record.validityType).toBe(0)
    expect(record.ttl).toBe(5 * 60 * 1e9)
    expect(record.consistent).toBe(true)
  })

  it('names the CID the value points at', () => {
    expect(valueCid(record)).toBe('bafybeigo6bgfcvr2lxdt74udz27mlpyhw5jngrqrj6vsqphqvvn6e6cgim')
    expect(valueCid({ ...record, value: '/ipns/k51abc' })).toBeNull()
  })

  it('reads the expiry to the millisecond', () => {
    expect(expiry(record)?.toISOString()).toBe('2026-10-21T13:42:51.990Z')
    expect(expiry({ ...record, validityType: 1 })).toBeNull()
    expect(expiry({ ...record, validity: 'soon' })).toBeNull()
  })
})

describe('the signature', () => {
  it('finds the Ed25519 key inside the name', () => {
    expect(publicKeyOfName(KEY)?.length).toBe(32)
    expect(publicKeyOfName('bafybeib4liozf4uwoq57zklkldjtfx5e7u65yl2e4prn3evpl6si3qgwr4')).toBeNull()
  })

  it('verifies against the name that signed it', async () => {
    expect(await verifyRecord(parseRecord(bytes()), KEY)).toEqual({ signature: 'valid', reason: '' })
  })

  it('fails against another name', async () => {
    expect((await verifyRecord(parseRecord(bytes()), OTHER_KEY)).signature).toBe('invalid')
  })

  it('fails when one signed byte is flipped', async () => {
    const flipped = bytes()
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 1
    expect((await verifyRecord(parseRecord(flipped), KEY)).signature).toBe('invalid')
  })

  it('fails when one byte of the signature is flipped', async () => {
    const flipped = bytes()
    const at = flipped.findIndex((_, i) => flipped[i] === 0x42 && flipped[i + 1] === 0x40) + 10
    flipped[at] = flipped[at]! ^ 1
    expect((await verifyRecord(parseRecord(flipped), KEY)).signature).toBe('invalid')
  })

  it('rejects a record whose unsigned sequence disagrees with the signed one', async () => {
    const forged = bytes()
    const at = forged.findIndex((_, i) => forged[i] === 0x28 && forged[i + 1] === 0x10)
    forged[at + 1] = 0x11
    const record = parseRecord(forged)
    expect(record.consistent).toBe(false)
    expect((await verifyRecord(record, KEY)).signature).toBe('invalid')
  })

  it('says not checked, and does not fail, when the browser has no Ed25519', async () => {
    const subtle = globalThis.crypto.subtle
    const original = subtle.importKey
    subtle.importKey = (() => Promise.reject(new DOMException('no', 'NotSupportedError'))) as typeof subtle.importKey
    try {
      expect((await verifyRecord(parseRecord(bytes()), KEY)).signature).toBe('not checked')
    } finally {
      subtle.importKey = original
    }
  })
})

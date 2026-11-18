// The Worker's Buffer, which is the shim's (the `buffer` package, v6), answers 'base64url' as Node's does: the spam-blocker challenge writes the payload of its challenge address with
// `Buffer.from(bytes).toString('base64url')`, which the shim's class refuses ("Unknown encoding: base64url") and pkc-js reports as "invalid getChallenge response".
import { Buffer as ShimBuffer } from 'buffer/'
import { afterEach, describe, expect, it } from 'vitest'
import { supportBase64Url } from '../worker/workarounds/base64url.js'

/** The class's own members as the shim gives them, put back after each test, since a patch is on the class itself and the bytes it makes are of that class. */
const original = { toString: ShimBuffer.prototype.toString, from: ShimBuffer.from, isEncoding: ShimBuffer.isEncoding }
afterEach(() => {
  ShimBuffer.prototype.toString = original.toString
  ShimBuffer.from = original.from
  ShimBuffer.isEncoding = original.isEncoding
})
const bytesOf = (...values: number[]): Uint8Array => Uint8Array.from(values)
const samples: Uint8Array[] = [bytesOf(), bytesOf(0), bytesOf(251, 255), bytesOf(251, 255, 254), bytesOf(1, 2, 3, 4), bytesOf(255, 255, 255, 255, 255), Uint8Array.from({ length: 1000 }, (_, i) => (i * 37 + 11) & 255)]

describe('the shim\'s Buffer without the workaround', () => {
  it('refuses base64url, which is what the spam-blocker challenge meets', () => {
    expect(() => ShimBuffer.from(bytesOf(251, 255)).toString('base64url')).toThrow(/Unknown encoding: base64url/)
    expect(ShimBuffer.isEncoding('base64url')).toBe(false)
  })
})

describe('supportBase64Url', () => {
  it('writes base64url as Node does: the URL alphabet and no padding', () => {
    const patched = ShimBuffer
    expect(supportBase64Url(patched)).toBe(true)
    for (const bytes of samples) expect(patched.from(bytes).toString('base64url')).toBe(Buffer.from(bytes).toString('base64url'))
    expect(patched.from(bytesOf(251, 255, 254)).toString('base64url')).toBe('-__-')
  })

  it('reads base64url as Node does, padded or not', () => {
    const patched = ShimBuffer
    supportBase64Url(patched)
    for (const bytes of samples) {
      const text = Buffer.from(bytes).toString('base64url')
      expect([...patched.from(text, 'base64url')]).toEqual([...bytes])
    }
    expect([...patched.from('-__-', 'base64url')]).toEqual([251, 255, 254])
  })

  it('answers isEncoding, in any case', () => {
    const patched = ShimBuffer
    supportBase64Url(patched)
    expect(patched.isEncoding('base64url')).toBe(true)
    expect(patched.isEncoding('BASE64URL')).toBe(true)
    expect(patched.isEncoding('hex')).toBe(true)
    expect(patched.isEncoding('nonsense')).toBe(false)
  })

  it('leaves every other encoding and every other form of the calls as they were', () => {
    const patched = ShimBuffer
    supportBase64Url(patched)
    const bytes = patched.from([104, 105, 251, 255])
    expect(bytes.toString()).toBe(ShimBuffer.from([104, 105, 251, 255]).toString())
    expect(bytes.toString('hex')).toBe('6869fbff')
    expect(bytes.toString('base64')).toBe('aGn7/w==')
    expect(bytes.toString('hex', 1, 3)).toBe('69fb')
    expect(patched.from('6869', 'hex').toString()).toBe('hi')
    expect([...patched.from([1, 2, 3])]).toEqual([1, 2, 3])
    expect(patched.from('abc').toString('utf8')).toBe('abc')
    expect(bytes.toString('base64url', 2)).toBe('-_8')
  })

  it('does nothing to a class that already knows base64url, and says so', () => {
    const before = Buffer.prototype.toString
    expect(supportBase64Url(Buffer)).toBe(false)
    expect(Buffer.prototype.toString).toBe(before)
  })

  it('patches a class once, however many times it is asked', () => {
    const patched = ShimBuffer
    expect(supportBase64Url(patched)).toBe(true)
    const once = patched.prototype.toString
    expect(supportBase64Url(patched)).toBe(false)
    expect(patched.prototype.toString).toBe(once)
  })
})

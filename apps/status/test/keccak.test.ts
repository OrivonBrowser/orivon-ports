import { describe, expect, it } from 'vitest'
import { toHex, utf8 } from '../site/bytes.js'
import { keccak256 } from '../site/keccak.js'

const hash = (text: string) => toHex(keccak256(utf8(text)))

describe('keccak-256', () => {
  it('matches the published vectors, which differ from NIST SHA3-256', () => {
    expect(hash('')).toBe('c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
    expect(hash('abc')).toBe('4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45')
    expect(hash('The quick brown fox jumps over the lazy dog')).toBe('4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15')
  })

  it('absorbs more than one 136-byte block', () => {
    expect(hash('a'.repeat(200))).toBe('96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d')
  })

  it('pads an input of exactly one block into a second one', () => {
    expect(keccak256(utf8('a'.repeat(136))).length).toBe(32)
    expect(hash('a'.repeat(136))).not.toBe(hash('a'.repeat(135)))
  })
})

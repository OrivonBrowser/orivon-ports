import { describe, expect, it } from 'vitest'
import { toHex } from '../site/sdk/bytes.js'
import { keyOf, MAX_LABEL_BYTES, parseOgName } from '../site/resolver/og-name.js'
import { labelOfKey } from '../tools/cut-census.mjs'

describe('parseOgName', () => {
  it('reads the label of a name under .og', () => {
    expect(parseOgName('alice.og')).toBe('alice')
    expect(parseOgName('a.og')).toBe('a')
    expect(parseOgName('a-b-9.og')).toBe('a-b-9')
  })

  it('ignores the case of .og and one trailing dot, and nothing else', () => {
    expect(parseOgName('alice.OG')).toBe('alice')
    expect(parseOgName('alice.og.')).toBe('alice')
    expect(() => parseOgName('alice.og..')).toThrow(expect.objectContaining({ code: 'invalid' }))
  })

  it('finds no name for a label that is not in ENSIP-15 form, so one name has one spelling', () => {
    for (const name of ['Alice.og', 'ALICE.OG', 'al ice.og', 'al_ice.og', '\uff41lice.og', `a${String.fromCodePoint(0x200d)}b.og`, '\u0430pple.og'.replace('\u0430', '\u0410')]) {
      expect(parseOgName(name), name).toBeNull()
    }
  })

  it('finds no name for an empty label or a name with a dot before .og', () => {
    for (const name of ['.og', 'og', 'a.b.og', 'www.alice.og', '..og']) expect(parseOgName(name), name).toBeNull()
  })

  it('finds no name for a label over 32 bytes, counted in UTF-8, and takes one of exactly 32', () => {
    expect(parseOgName(`${'a'.repeat(MAX_LABEL_BYTES)}.og`)).toBe('a'.repeat(MAX_LABEL_BYTES))
    expect(parseOgName(`${'a'.repeat(MAX_LABEL_BYTES + 1)}.og`)).toBeNull()
    expect(parseOgName(`${'é'.repeat(16)}.og`)).toBe('é'.repeat(16))
    expect(parseOgName(`${'é'.repeat(17)}.og`)).toBeNull()
  })

  it('refuses a name outside .og as invalid, so the router sends it elsewhere', () => {
    for (const name of ['alice.eth', 'alice', 'alice.og.eth', '']) expect(() => parseOgName(name), name).toThrow(expect.objectContaining({ code: 'invalid' }))
    for (const name of [undefined, null, 7, {}, ['alice.og']]) expect(() => parseOgName(name), String(name)).toThrow(expect.objectContaining({ code: 'invalid' }))
  })
})

describe('keyOf', () => {
  it('is the label\'s UTF-8 bytes, padded with zeros to 32', () => {
    expect(keyOf('ecdn')).toBe(`0x6563646e${'00'.repeat(28)}`)
    expect(keyOf('é')).toBe(`0xc3a9${'00'.repeat(30)}`)
    expect(keyOf('a'.repeat(32))).toBe(`0x${'61'.repeat(32)}`)
  })

  it('is what the registry files the live names under', () => {
    expect(keyOf('chaosroadsmint')).toBe('0x6368616f73726f6164736d696e74000000000000000000000000000000000000')
    expect(toHex(new TextEncoder().encode('mason'))).toBe('6d61736f6e')
    expect(keyOf('mason')).toBe(`0x6d61736f6e${'00'.repeat(27)}`)
  })
})

describe('labelOfKey, the census tool\'s way back from a key to a label', () => {
  it('reads a key that is a label this resolver answers', () => {
    expect(labelOfKey(keyOf('chaosroadsmint'))).toBe('chaosroadsmint')
    expect(labelOfKey(keyOf('é'))).toBe('é')
    expect(labelOfKey(keyOf('a'.repeat(32)))).toBe('a'.repeat(32))
  })

  it('finds no label in a key that is not one: empty, not text, or a spelling this resolver does not answer', () => {
    expect(labelOfKey(`0x${'00'.repeat(32)}`)).toBeNull()
    expect(labelOfKey(`0xff${'00'.repeat(31)}`)).toBeNull()
    expect(labelOfKey(keyOf('Alice'))).toBeNull()
    expect(labelOfKey(`0x${'11'.repeat(32)}`)).toBeNull()
  })
})

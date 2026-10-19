import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { Universe, parseSource, sameChannel } from './ipc-source.ts'

const expression = (text: string): { node: ts.Expression; source: ReturnType<typeof parseSource> } => {
  const source = parseSource('use.js', `${text}\n`)
  return { node: (source.tree.statements[0] as ts.ExpressionStatement).expression, source }
}

describe('channel names', () => {
  const universe = Universe.of({
    'a.js': "export const Ch = Object.freeze({ A: 'a', deep: { B: 'b' } })\nexport const Two = { X: 'one' }",
    'b.js': "const Two = { X: 'two' }\nexport const Plain = 'plain'",
    'c.ts': "enum E { M = 'enum-m' }"
  })
  const nameOf = (text: string): string | undefined => {
    const { node, source } = expression(text)
    return universe.channelOf(node, source).name
  }

  it('evaluates a literal, a frozen object, a nested key and an enum member', () => {
    expect(nameOf("'lit'")).toBe('lit')
    expect(nameOf('Ch.A')).toBe('a')
    expect(nameOf('Ch.deep.B')).toBe('b')
    expect(nameOf("Ch['A']")).toBe('a')
    expect(nameOf('E.M')).toBe('enum-m')
    expect(nameOf('Plain')).toBe('plain')
  })

  it('leaves a name unread when two declarations disagree, or when it is computed', () => {
    expect(nameOf('Two.X')).toBeUndefined()
    expect(nameOf('Ch.missing')).toBeUndefined()
    expect(nameOf('`${prefix}x`')).toBeUndefined()
    expect(nameOf('make(1).NAME')).toBeUndefined()
  })

  it('treats two unread channels as the same only when they are spelled the same', () => {
    expect(sameChannel({ text: 'a.B', name: undefined }, { text: 'a.B', name: undefined })).toBe(true)
    expect(sameChannel({ text: 'a.B', name: undefined }, { text: 'x', name: 'x' })).toBe(false)
    expect(sameChannel({ text: '"x"', name: 'x' }, { text: 'K.X', name: 'x' })).toBe(true)
  })
})

describe('imports', () => {
  it('resolves a relative specifier with or without an extension, and an index file', () => {
    const universe = Universe.of({ 'src/a/x.ts': '', 'src/b/index.js': '', 'src/c.js': '' })
    expect(universe.resolveImport('src/a/y.ts', './x')).toBe('src/a/x.ts')
    expect(universe.resolveImport('src/a/y.ts', './x.js')).toBe('src/a/x.ts')
    expect(universe.resolveImport('src/a/y.ts', '../b')).toBe('src/b/index.js')
    expect(universe.resolveImport('src/a/y.ts', '../c.js')).toBe('src/c.js')
    expect(universe.resolveImport('src/a/y.ts', 'react')).toBeUndefined()
  })
})

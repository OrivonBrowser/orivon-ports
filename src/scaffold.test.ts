import { describe, expect, it } from 'vitest'
import { fill, toBridgeName } from './scaffold.ts'

describe('toBridgeName', () => {
  it('camel-cases a dashed id', () => {
    expect(toBridgeName('freetube')).toBe('freetubeApi')
    expect(toBridgeName('my-cool-app')).toBe('myCoolAppApi')
  })
})

describe('fill', () => {
  const plan = { id: 'ft', name: 'FreeTube', bridgeName: 'ftApi', port: 8875 }

  it('substitutes every placeholder', () => {
    expect(fill('{{id}} {{name}} {{bridgeName}} {{port}}', plan)).toBe('ft FreeTube ftApi 8875')
  })

  // A template that quietly keeps `{{whatever}}` ships a broken recipe that
  // fails much later, in JSON parsing or at build time.
  it('throws on an unknown placeholder rather than leaving it in the file', () => {
    expect(() => fill('{{nope}}', plan)).toThrow(/nope/)
  })
})

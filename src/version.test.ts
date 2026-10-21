import { describe, expect, it } from 'vitest'
import { compareVersions, firstBuild, parseVersion, raiseBuild, withVersion } from './version.ts'

describe('raiseBuild', () => {
  it('raises the last number', () => {
    expect(raiseBuild('0.24.0.2')).toBe('0.24.0.3')
    expect(raiseBuild('0.1.0')).toBe('0.1.1')
    expect(raiseBuild('4.5.2.9')).toBe('4.5.2.10')
  })

  it('treats a version with no build part like any other: its last number is the one raised', () => {
    expect(raiseBuild('7')).toBe('8')
  })

  it('refuses a part that is not a number', () => {
    for (const bad of ['1.2.3-beta', '1.2.x', '', '1..2', 'v1.2', '1.2.3.']) expect(() => raiseBuild(bad)).toThrow(/not a version/)
  })
})

describe('firstBuild', () => {
  it('appends build 1 to an upstream release', () => {
    expect(firstBuild('1.12.33')).toBe('1.12.33.1')
  })

  it('refuses an upstream version with a non-numeric part', () => {
    expect(() => firstBuild('1.12.33-rc1')).toThrow(/not a version/)
  })
})

describe('compareVersions', () => {
  it('orders part by part, with a missing part as 0', () => {
    expect(compareVersions('0.25.3.1', '0.25.3')).toBeGreaterThan(0)
    expect(compareVersions('0.25.3', '0.25.3.0')).toBe(0)
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0)
  })

  it('throws on a version it cannot order', () => {
    expect(() => compareVersions('1.0', '1.x')).toThrow(/not a version/)
  })
})

describe('parseVersion', () => {
  it('returns the numeric parts', () => {
    expect(parseVersion('0.24.0.2')).toEqual([0, 24, 0, 2])
    expect(parseVersion('1.0-beta')).toBeUndefined()
  })
})

describe('withVersion', () => {
  const text = '{\n  "id": "x",\n    "version":   "0.24.0.2" ,\n  "entry": "index.html" // kept\n}\n'

  it('replaces the value and no other byte', () => {
    expect(withVersion(text, '0.24.0.3')).toBe(text.replace('0.24.0.2', '0.24.0.3'))
  })

  it('refuses a manifest with no version or with two', () => {
    expect(() => withVersion('{"id":"x"}', '1')).toThrow(/found 0/)
    expect(() => withVersion('{"version":"1","a":{"version":"2"}}', '3')).toThrow(/found 2/)
  })
})

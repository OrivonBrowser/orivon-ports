import { describe, expect, it } from 'vitest'
import { formatChecks } from './doctor.ts'

describe('formatChecks', () => {
  it('aligns the what column and marks each level', () => {
    const lines = formatChecks([
      { level: 'ok', what: 'git', detail: '2.43.0' },
      { level: 'warn', what: 'pnpm', detail: 'not on PATH' },
      { level: 'fail', what: 'node runs TypeScript', detail: 'no' }
    ]).split('\n')
    expect(lines[0]).toBe('[  ok  ] git                   2.43.0')
    expect(lines[1]).toContain(' warn ')
    expect(lines[2]).toContain(' FAIL ')
    expect(new Set(lines.map((line) => line.indexOf('  ', 9))).size).toBeGreaterThan(0)
  })
})

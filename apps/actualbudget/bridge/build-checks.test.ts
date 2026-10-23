// The build's refusals, each handed a real violation.
import { describe, expect, it } from 'vitest'
import { dynamicRequires, installFileProblems, metafileProblems, versionProblem } from './build-checks.js'

describe('versionProblem', () => {
  it('passes the release the bridge answers for and names both versions otherwise', () => {
    expect(versionProblem('26.10.0', '26.10.0')).toBeNull()
    expect(versionProblem('26.11.0', '26.10.0')).toMatch(/26\.11\.0.*26\.10\.0/)
  })
})

describe('installFileProblems', () => {
  const complete = ['default-db.sqlite', 'migrations/1_a.sql', 'migrations/2_b.js']
  it('passes a complete tree', () => {
    expect(installFileProblems(complete)).toEqual([])
  })
  it('names the template, the sql migrations and the js migrations when each is missing', () => {
    expect(installFileProblems(['migrations/1_a.sql', 'migrations/2_b.js']).join()).toMatch(/default-db/)
    expect(installFileProblems(['default-db.sqlite', 'migrations/2_b.js']).join()).toMatch(/\.sql/)
    expect(installFileProblems(['default-db.sqlite', 'migrations/1_a.sql']).join()).toMatch(/\.js/)
  })
})

describe('metafileProblems', () => {
  const backend = 'packages/loot-core/lib-dist/electron/bundle.desktop.js'
  const adapter = '../orivon-mvp/src/shim/sqlite/better-sqlite3.ts'
  it('passes a bundle that holds the backend and the shim\'s adapter', () => {
    expect(metafileProblems([backend, adapter], backend)).toEqual([])
  })
  it('fails when the backend is absent', () => {
    expect(metafileProblems([adapter], backend).join()).toMatch(/missing/)
  })
  it('fails when the native module is bundled, and when the adapter is not', () => {
    expect(metafileProblems([backend, adapter, 'node_modules/better-sqlite3/lib/index.js'], backend).join()).toMatch(/native module/)
    expect(metafileProblems([backend], backend).join()).toMatch(/adapter/)
  })
})

describe('dynamicRequires', () => {
  it('finds a require whose argument is not a string, and ignores those with a literal one', () => {
    const code = 'a = __require("fs"); b = __require(\'path\'); c = __require(name); d = __require(`x`)'
    expect(dynamicRequires(code)).toEqual(['server.mjs: __require(name) is left in the bundle for run time and is not on the declared list'])
  })
  it('passes a declared one and fails a declaration the bundle no longer holds', () => {
    const declared = [{ pattern: /^__require\(name\)$/, why: 'read' }]
    expect(dynamicRequires('__require(name)', declared)).toEqual([])
    expect(dynamicRequires('1', declared).join()).toMatch(/no longer appears/)
  })
})

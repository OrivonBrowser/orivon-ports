// The build's gates, each handed the violation it exists to catch. The
// require() texts are esbuild's own output for upstream's pinned sources.
import { describe, expect, it } from 'vitest'
import {
  blankLiterals, checkMetafile, checkRequires, computedModules, DECLARED_REQUIRES, installFileProblems,
  moduleLocation, requireCalls, REQUIRED_INSTALL_FILES, stampOf, unmappedBuiltins, withModuleScope
} from './bundle-plan.js'

const CLONE = '/work/out/the-lounge/source'
const INSTALL = '/orivon/app/lounge-install'

describe('moduleLocation', () => {
  it('puts a server module where tsc would, so upstream\'s relative paths land in the install tree', () => {
    expect(moduleLocation(`${CLONE}/server/rootpath.ts`, CLONE, INSTALL)).toEqual({
      dirname: `${INSTALL}/dist/server`,
      filename: `${INSTALL}/dist/server/rootpath.js`
    })
    expect(moduleLocation(`${CLONE}/server/command-line/start.ts`, CLONE, INSTALL)?.dirname).toBe(`${INSTALL}/dist/server/command-line`)
    expect(moduleLocation(`${CLONE}/shared/irc.ts`, CLONE, INSTALL)?.filename).toBe(`${INSTALL}/dist/shared/irc.js`)
  })

  it('gives nothing to a dependency, a declaration or a file outside the clone', () => {
    for (const file of [`${CLONE}/node_modules/express/index.js`, `${CLONE}/server/types/x.d.ts`, `${CLONE}/client/js/x.ts`, '/work/apps/the-lounge/bridge/a.js']) {
      expect(moduleLocation(file, CLONE, INSTALL)).toBeNull()
    }
  })
})

describe('withModuleScope', () => {
  const where = { dirname: '/i/dist/server', filename: '/i/dist/server/a.js' }

  it('declares __dirname and __filename on the first line, so a stack trace keeps its line numbers', () => {
    const out = withModuleScope('import x from "y"\nx(__dirname)\n', where)
    expect(out.split('\n')[0]).toBe('const __dirname = "/i/dist/server", __filename = "/i/dist/server/a.js"; import x from "y"')
    expect(out.split('\n')).toHaveLength(3)
  })

  it('gives a module that sets a flag through module.exports a module of its own', () => {
    expect(withModuleScope('module.exports.flag = true', where)).toBe('const module = { exports: {} }; module.exports.flag = true')
    expect(withModuleScope('a(__dirname); module.exports.b = 1', where)).toContain('__filename = "/i/dist/server/a.js", module = { exports: {} };')
  })

  it('leaves a module that reads none of the three exactly as it is', () => {
    const source = 'export const answer = 42\nconst modules = 1\n'
    expect(withModuleScope(source, where)).toBe(source)
    expect(withModuleScope('__dirname', null)).toBe('__dirname')
  })
})

describe('blankLiterals', () => {
  it('blanks comments and the inside of strings, keeping every offset', () => {
    const code = 'a("require(x)") // require(y)\n/* require(z) */ b(`require(${q}) tail`)\n'
    const out = blankLiterals(code)
    expect(out).toHaveLength(code.length)
    expect(out).not.toContain('require(x)')
    expect(out).not.toContain('require(y)')
    expect(out).not.toContain('require(z)')
    expect(out).toContain('${q}')
  })

  it('reads code inside a template expression, nested and repeated', () => {
    const out = blankLiterals('t(`a ${f(`b ${__require(n)}`)} c ${__require(m)} d`)')
    expect(out).toContain('__require(n)')
    expect(out).toContain('__require(m)')
  })

  it('takes a quote inside a regular expression for part of it, and a division for a division', () => {
    const out = blankLiterals('const r = /["\']/g; const h = a / b; x(__require(n)); const s = "tail"')
    expect(out).toContain('__require(n)')
    expect(out).toContain('const s = "    "')
  })
})

describe('requireCalls', () => {
  it('finds a call across lines, with its argument on one line, and tells a literal name from a computed one', () => {
    const code = 'var a = __require("tty");\nvalues = __require(path_default.resolve(\n  path_default.join(__dirname, "..", "defaults", "config.js")\n));\n'
    expect(requireCalls(code)).toEqual([
      { text: '__require("tty")', literal: true, line: 1 },
      { text: '__require(path_default.resolve(path_default.join(__dirname, "..", "defaults", "config.js")))', literal: false, line: 2 }
    ])
  })

  it('finds require.resolve, and ignores a name that merely contains require, a helper and text inside a string', () => {
    const code = 'x = __require.resolve("yarn/bin/yarn.js"); y = require_thing(); z = obj.require(q); w = "__require(n)"; return require.apply(this, arguments)'
    expect(requireCalls(code).map((call) => call.text)).toEqual(['__require.resolve("yarn/bin/yarn.js")'])
  })
})

describe('checkRequires', () => {
  const FIXTURE = [
    'values = __require(path_default.resolve(\n path_default.join(__dirname3, "..", "defaults", "config.js")\n));',
    'const userConfig = __require(configPath);',
    'const server = __require(newLocal);',
    'return new (__require(adapters[adapter2]))(options);',
    'packageFile = __require(packagePath);',
    'const yarn = __require.resolve("yarn/bin/yarn.js");',
    'const dtrace = __require("dtrace-provider");',
    'const bufferUtil = __require("bufferutil");',
    'var fn = __require(mod).__express;'
  ].join('\n')

  it('passes the calls upstream\'s pinned sources leave, each declared and each still present', () => {
    expect(checkRequires(FIXTURE)).toEqual([])
  })

  it('fails on a computed require nobody declared', () => {
    const problems = checkRequires(`${FIXTURE}\nconst plugin = __require(someName);`)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('__require(someName)')
    expect(problems[0]).toContain('line 12')
  })

  it('fails on a literal name the bundle left for run time, such as a builtin no alias took', () => {
    expect(checkRequires(`${FIXTURE}\nvar tty = __require("tty");`)[0]).toContain('__require("tty")')
  })

  it('fails on a declared call that has gone, so the list cannot go stale', () => {
    const problems = checkRequires(FIXTURE.replace('__require(newLocal)', '0'))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('newLocal')
  })

  it('declares a reason for every entry', () => {
    for (const entry of DECLARED_REQUIRES) expect(entry.why.length).toBeGreaterThan(20)
  })
})

describe('checkMetafile', () => {
  const required = ['server/plugins/irc-events/away.ts', 'server/plugins/inputs/msg.ts'].map((path) => ({ path, why: 'loaded by a computed name' }))
  const forbidden = [{ prefix: 'node_modules/vite/', why: 'the dev server is refused' }]

  it('passes a bundle that holds every computed module and nothing forbidden', () => {
    expect(checkMetafile([...required.map((entry) => entry.path), 'server/server.ts'], { required, forbidden })).toEqual([])
  })

  it('names a computed module the bundle lacks', () => {
    const problems = checkMetafile(['server/plugins/irc-events/away.ts'], { required, forbidden })
    expect(problems).toEqual(['the bundle is missing server/plugins/inputs/msg.ts: loaded by a computed name'])
  })

  it('names a forbidden input the bundle carries', () => {
    const problems = checkMetafile([...required.map((entry) => entry.path), 'node_modules/vite/dist/node/index.js'], { required, forbidden })
    expect(problems).toEqual(['the bundle holds node_modules/vite/dist/node/index.js: the dev server is refused'])
  })
})

describe('computedModules', () => {
  it('lists a directory\'s modules without its declarations, its index and anything that is not a source', () => {
    const names = ['away.ts', 'index.ts', 'types.d.ts', 'README.md', 'msg.ts']
    expect(computedModules('server/plugins/inputs', names)).toEqual(['server/plugins/inputs/away.ts', 'server/plugins/inputs/msg.ts'])
  })
})

describe('installFileProblems', () => {
  const complete = [...REQUIRED_INSTALL_FILES, 'public/themes/default.css']

  it('accepts a complete install tree', () => {
    expect(installFileProblems(complete)).toEqual([])
  })

  it('names each file the server reads at start that the tree lacks', () => {
    const problems = installFileProblems(complete.filter((path) => path !== 'public/thelounge.webmanifest' && !path.startsWith('public/themes/')))
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('public/thelounge.webmanifest')
    expect(problems[1]).toContain('public/themes')
  })
})

describe('stampOf', () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

  it('is the same for the same files in any order, and changes with a name or a byte', () => {
    const a: [string, Uint8Array][] = [['a', bytes('1')], ['b', bytes('2')]]
    expect(stampOf(a)).toBe(stampOf([a[1]!, a[0]!]))
    expect(stampOf(a)).not.toBe(stampOf([['a', bytes('1')], ['b', bytes('3')]]))
    expect(stampOf(a)).not.toBe(stampOf([['a', bytes('1')], ['c', bytes('2')]]))
    expect(stampOf(a)).toMatch(/^[0-9a-f]{24}$/)
  })

  it('does not let a name and a body trade bytes', () => {
    expect(stampOf([['ab', bytes('c')]])).not.toBe(stampOf([['a', bytes('bc')]]))
  })
})

describe('unmappedBuiltins', () => {
  it('groups the plugin\'s errors by builtin, and ignores any other error', () => {
    const texts = [
      "'tty' is a Node builtin the Orivon shim has no module for (imported from /c/node_modules/debug/src/node.js); see src/shim/module-map.ts",
      "'tty' is a Node builtin the Orivon shim has no module for (imported from /c/node_modules/supports-color/index.js); see src/shim/module-map.ts",
      "'node:sqlite' is a Node builtin the Orivon shim has no module for (imported from /c/server/plugins/messageStorage/sqlite.ts); see src/shim/module-map.ts",
      'Could not resolve "left-pad"'
    ]
    expect(unmappedBuiltins(texts)).toEqual(new Map([
      ['tty', ['/c/node_modules/debug/src/node.js', '/c/node_modules/supports-color/index.js']],
      ['node:sqlite', ['/c/server/plugins/messageStorage/sqlite.ts']]
    ]))
  })
})

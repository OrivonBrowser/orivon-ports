// The build's gates, each handed the violation it exists to catch. The
// require() texts are esbuild's own output for upstream's pinned sources.
import { describe, expect, it } from 'vitest'
import {
  blankLiterals, checkGlobLookups, checkMetafile, checkRequires, computedModules, DECLARED_REQUIRES, installDirFor, installFileProblems,
  moduleLocation, requireCalls, REQUIRED_INSTALL_FILES, rewrittenInputs, stampOf, unmappedBuiltins, withModuleScope, withSourceRewrites
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

  it('starts a regular expression after a keyword, and divides after a property that is named like one', () => {
    const regex = 'function f (s) { return /[`*_]/.test(s) }\nx = __require(n)\nconst t = `tail`'
    const out = blankLiterals(regex)
    expect(out).toContain('__require(n)')
    expect(out).toContain('const t = `    `')
    for (const word of ['typeof', 'case', 'in', 'of', 'void', 'yield', 'delete', 'throw', 'new', 'else', 'do', 'instanceof', 'await']) {
      const kept = blankLiterals(`${word} /["'\`]/g\ny = __require(n)`)
      expect(kept, word).toContain('__require(n)')
      expect(kept, word).not.toContain('["')
    }
    const division = blankLiterals('a = b.return / 2; c = `x`; d = e.in / 3 / f; g = __require(m)')
    expect(division).toContain('c = `')
    expect(division).toContain('__require(m)')
    expect(division).toContain('b.return / 2')
  })

  it('keeps every offset and newline on a large input without splitting it into characters', () => {
    const code = `${'var a = "x"; // note\n'.repeat(200_000)}__require(n)\n`
    const out = blankLiterals(code)
    expect(out).toHaveLength(code.length)
    expect(out.endsWith('__require(n)\n')).toBe(true)
    expect(out.split('\n')).toHaveLength(code.split('\n').length)
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
      { text: '__require("tty")', line: 1 },
      { text: '__require(path_default.resolve(path_default.join(__dirname, "..", "defaults", "config.js")))', line: 2 }
    ])
  })

  it('finds a call after a regular expression that holds a backtick, which a division reading would take for a template', () => {
    const code = 'function f (s) {\n  return /[`*_]/.test(s)\n}\nvar x = __require(packagePath);\n'
    expect(requireCalls(code)).toEqual([{ text: '__require(packagePath)', line: 4 }])
  })

  it('counts lines from the start of the file, for a call late in a large input', () => {
    const code = `${'a\n'.repeat(50_000)}__require(x)`
    expect(requireCalls(code)[0]?.line).toBe(50_001)
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
    expect(problems[0]).toContain('line 11')
  })

  it('fails on a literal name the bundle left for run time, such as a builtin no alias took', () => {
    expect(checkRequires(`${FIXTURE}\nvar tty = __require("tty");`)[0]).toContain('__require("tty")')
  })

  it('fails on a declared call that has gone, so the list cannot go stale', () => {
    const problems = checkRequires(FIXTURE.replace('__require(packagePath)', '0'))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('packagePath')
  })

  it('fails on the server require upstream writes with a name in a variable, which the rewrite exists to remove', () => {
    const problems = checkRequires(`${FIXTURE}\nconst server = __require(newLocal);`)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('__require(newLocal)')
  })

  it('takes a blanked copy, so a caller blanks the bundle once', () => {
    expect(checkRequires(FIXTURE, { blanked: blankLiterals(FIXTURE) })).toEqual([])
    expect(checkRequires(FIXTURE, { blanked: ' '.repeat(FIXTURE.length) })).not.toEqual([])
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

describe('withSourceRewrites', () => {
  const START = 'const newLocal = "../server";\n// eslint-disable-next-line\nconst server = require(newLocal);\nserver.default(options);'

  it('gives the irc-events import and the inputs import an extension, so the lookup hits the glob map\'s key', () => {
    expect(withSourceRewrites('await import(`./plugins/irc-events/${plugin}`)', 'server/client.ts')).toBe('await import(`./plugins/irc-events/${plugin}.ts`)')
    expect(withSourceRewrites('import(`./${input}`).then()', 'server/plugins/inputs/index.ts')).toBe('import(`./${input}.ts`).then()')
  })

  it('turns the server require in start.ts into a static one esbuild bundles', () => {
    const out = withSourceRewrites(START, 'server/command-line/start.ts')
    expect(out).toContain('const server = require("../server");')
    expect(out).not.toContain('require(newLocal)')
  })

  it('leaves every other file alone', () => {
    expect(withSourceRewrites('import(`./${input}`)', 'server/other.ts')).toBe('import(`./${input}`)')
    expect(withSourceRewrites(START, 'server/other.ts')).toBe(START)
  })

  it('fails when upstream changed the text it rewrites, rather than leave a lookup or a require that misses', () => {
    expect(() => withSourceRewrites('import(`./${name}`)', 'server/plugins/inputs/index.ts')).toThrow('no longer contains')
    expect(() => withSourceRewrites(START.replace('require(newLocal)', 'require(other)'), 'server/command-line/start.ts')).toThrow('no longer contains')
    expect(() => withSourceRewrites(START.replace('"../server"', '"./elsewhere"'), 'server/command-line/start.ts')).toThrow('const newLocal = "../server"')
  })

  it('names the module the bundle must hold once the server require is static, and the metafile gate fails without it', () => {
    const required = rewrittenInputs().map((entry) => ({ path: entry.path, why: entry.why }))
    expect(required.map((entry) => entry.path)).toEqual(['server/server.ts'])
    expect(checkMetafile(['server/index.ts'], { required, forbidden: [] })[0]).toContain('the rewrite did not take effect')
    expect(checkMetafile(['server/index.ts', 'server/server.ts'], { required, forbidden: [] })).toEqual([])
  })
})

describe('installDirFor', () => {
  it('keys the install tree by its stamp, under the one directory that holds them all', () => {
    expect(installDirFor('0123456789abcdef01234567')).toBe('lounge-install/0123456789abcdef01234567')
  })
})

describe('checkGlobLookups', () => {
  const ok = 'globImport(`./${input24}.ts`).then(x)\nawait globImport_plugins_irc_events(`./plugins/irc-events/${plugin}.ts`)'

  it('passes the two lookups esbuild prints once the extension is in the template', () => {
    expect(checkGlobLookups(ok)).toEqual([])
  })

  it('fails on a lookup without the extension, which is the miss the glob map gives at run time', () => {
    const problems = checkGlobLookups(ok.replace('${input24}.ts', '${input24}'))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('without its extension')
  })

  it('fails when a lookup has gone, so the rewrite cannot have applied to nothing', () => {
    expect(checkGlobLookups('globImport(`./${a}.ts`)')[0]).toContain('expected 2 glob lookups, found 1')
  })
})

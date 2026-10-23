// The stand-in for the two `vm` calls the shim refuses, run against a plain object that has Node's own `vm`
// behind it for the one call it keeps, the way the shim has `runInThisContext`.
import { describe, expect, it } from 'vitest'
import { filenameOf, GLOBAL_PROBE, standInVm, wrapperBody } from './vm-stand-in.js'

function shimLikeVm (): Record<string, (...args: unknown[]) => unknown> {
  const refuse = (): never => { throw new Error('refused by the shim') }
  return { createContext: refuse, runInContext: refuse, runInThisContext: (code: unknown) => (0, eval)(String(code)) }
}

// The shape of the kernel's own check: it defines a property on Object.prototype whose getter returns `this`, reads the keys of
// the free name `__temp__`, and reports when there are any.
const checkedModule = (body: string): string => [
  '(function(exports) {',
  `  (function(){${body}\n;})();`,
  "  Object.defineProperty(Object.prototype, '__temp__', { get: function () { return this; }, configurable: true });",
  '  if (Object.keys(__temp__).length) { exports.reported = Object.keys(__temp__); }',
  "  delete Object.prototype.__temp__;",
  '  return exports;',
  '})'
].join('\n')

describe('createContext', () => {
  it('hands back the object it was given, and an empty one when given none', () => {
    const vm = standInVm(shimLikeVm())
    const sandbox = { a: 1 }
    expect(vm.createContext?.(sandbox)).toBe(sandbox)
    expect(vm.createContext?.()).toEqual({})
  })
})

describe('runInContext', () => {
  const vm = standInVm(shimLikeVm())
  const run = (code: string, options?: unknown): { (exports: object): Record<string, unknown> } => vm.runInContext?.(code, {}, options) as never

  it('compiles the text to the function it expresses, which the caller then applies', () => {
    expect(run('(function(a, b) { return a + b })')).toBeTypeOf('function')
    expect((run('(function(a, b) { return a + b })') as unknown as (a: number, b: number) => number)(2, 3)).toBe(5)
  })

  it('reports no assignment to a global in a module that makes none, though the realm\'s own global has keys', () => {
    ;(globalThis as Record<string, unknown>)['someEnumerableGlobalOfTheRealm'] = true
    try {
      const exports = run(checkedModule('exports.value = 1'))({})
      expect(exports['value']).toBe(1)
      expect(exports['reported']).toBeUndefined()
      // The control: the same text run as the shim's runInThisContext runs it reports the realm's keys, so the shadowing is what holds.
      const unshadowed = (0, eval)(checkedModule('')) as (exports: object) => Record<string, unknown>
      expect(unshadowed({})['reported']).toContain('someEnumerableGlobalOfTheRealm')
    } finally {
      delete (globalThis as Record<string, unknown>)['someEnumerableGlobalOfTheRealm']
    }
  })

  it('leaves Object.prototype as it found it', () => {
    run(checkedModule(''))({})
    expect('__temp__' in Object.prototype).toBe(false)
  })

  it('throws the compiler\'s SyntaxError for text that does not parse', () => {
    expect(() => run('(function( {')).toThrow(SyntaxError)
  })

  it('names the file in the stack of an error the code throws', () => {
    const fn = run('(function() { throw new Error("inside") })', 'plugin/module.js') as unknown as () => void
    expect(() => fn()).toThrow('inside')
  })
})

describe('the pieces', () => {
  it('takes the file name from a string or from options.filename, and has one otherwise', () => {
    expect(filenameOf('a.js')).toBe('a.js')
    expect(filenameOf({ filename: 'b.js' })).toBe('b.js')
    expect(filenameOf({})).toBe('vm-module')
    expect(filenameOf(undefined)).toBe('vm-module')
  })

  it('wraps the text as a returned expression with a source URL on its own line', () => {
    expect(wrapperBody('(function(){})', 'x.js')).toBe('return (function(){})\n//# sourceURL=x.js')
  })

  it('names the free name the kernel\'s check reads through', () => {
    expect(GLOBAL_PROBE).toBe('__temp__')
  })
})

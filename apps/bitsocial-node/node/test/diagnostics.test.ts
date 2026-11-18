// What the Worker lets pkc-js say about itself: the namespaces its logger is told to write before it loads, and the line the build's
// patched logger hands over.
import { describe, expect, it } from 'vitest'
import { debugNamespaces, diagnosticLine, routeLog, START_NAMESPACES } from '../worker/diagnostics.js'

const config = (debug?: unknown): string => JSON.stringify({ authKey: 'k'.repeat(32), ...(debug === undefined ? {} : { debug }) })

describe('debugNamespaces', () => {
  it('always has the start-up namespaces, which say whether the boards started before come back', () => {
    expect(debugNamespaces(config())).toBe(START_NAMESPACES)
    expect(START_NAMESPACES).toMatch(/pkc-js-rpc:pkc-ws-server:auto-start\*/)
    expect(START_NAMESPACES).toMatch(/pkc-js:node:setupKuboHttpRouters\*/)
  })

  it('adds the namespaces the page asked for, after any the environment had', () => {
    expect(debugNamespaces(config('pkc-js:local-community:*'))).toBe(`${START_NAMESPACES},pkc-js:local-community:*`)
    expect(debugNamespaces(config('pkc-js:local-community:*'), 'pkc-js:pkc:*')).toBe(`pkc-js:pkc:*,${START_NAMESPACES},pkc-js:local-community:*`)
  })

  it.each([['not JSON', '{'], ['no value', undefined], ['a command', config('pkc*; rm -rf /')], ['not text', config(7)]])('ignores what is not a configuration or not a namespace list: %s', (_name, text) => {
    expect(debugNamespaces(text as string | undefined)).toBe(START_NAMESPACES)
  })
})

describe('diagnosticLine', () => {
  it('makes one line of what pkc-js\'s logger passes: text, an error with where it came from, a value as JSON', () => {
    const error = new Error('Community already started')
    error.stack = 'Error: Community already started\n    at start (a.js:1:1)\n    at async b (b.js:2:2)'
    expect(diagnosticLine(['Failed to auto-start', error, { address: '12D3' }])).toBe('Failed to auto-start Error: Community already started | at start (a.js:1:1) | at async b (b.js:2:2) {"address":"12D3"}')
  })

  it('keeps a long line to a bounded size, and a value that cannot be written as JSON still says something', () => {
    expect(diagnosticLine(['x'.repeat(5000)]).length).toBeLessThan(1600)
    const loop: Record<string, unknown> = {}
    loop['self'] = loop
    expect(diagnosticLine([loop])).toBe('[object Object]')
  })

  it('puts a multi-line message on one line', () => {
    expect(diagnosticLine(['a\n   b\nc'])).toBe('a b c')
  })
})

describe('routeLog', () => {
  it('leaves the hook the patched logger calls, which writes a warning', () => {
    const scope: Record<string, any> = {}
    const warned: string[] = []
    routeLog(scope, (line) => { warned.push(line) })
    scope['__bitsocialPkcLog']('pkc-js-rpc:pkc-ws-server:auto-start Auto-starting 2 communities')
    expect(warned).toEqual(['pkc-js pkc-js-rpc:pkc-ws-server:auto-start Auto-starting 2 communities'])
  })
})

// What an install holds a name resolver to: the functions and the behaviour vectors of Orivon's official NAMES_0_1 and NAMES_0_2
// modules, transcribed from them, and the way an install runs them. A vector is handed to the resolver's page as a call, below the
// router, so the code the page throws is the code the vector reads; one marked `live` needs the real network and an install leaves it
// out; one whose arguments break the function's declared shape is never handed over, and passes only when it expects `invalid`.

export interface ArgSpec { name: string, maxLength?: number, values?: readonly string[] }
export interface FunctionSpec { args: readonly ArgSpec[], deadlineMs: number }
export type Expect = { kind: 'error', code: string } | { kind: 'shape' }
export interface Vector { fn: string, args: readonly string[], expect: Expect, live?: true }
export interface NamesStandard { code: string, functions: Readonly<Record<string, FunctionSpec>>, vectors: readonly Vector[] }

const RESOLVE: FunctionSpec = { args: [{ name: 'name', maxLength: 253 }], deadlineMs: 30_000 }
const SET_RECORD: FunctionSpec = {
  args: [{ name: 'name', maxLength: 253 }, { name: 'recordType', values: ['contenthash'] }, { name: 'value', maxLength: 300 }],
  deadlineMs: 60_000
}
const invalid: Expect = { kind: 'error', code: 'invalid' }
const CID = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

export const NAMES_0_1: NamesStandard = {
  code: 'NAMES_0_1',
  functions: { resolve: RESOLVE },
  vectors: [
    { fn: 'resolve', args: ['not a name!'], expect: invalid },
    { fn: 'resolve', args: ['vitalik.eth'], expect: { kind: 'shape' }, live: true }
  ]
}

export const NAMES_0_2: NamesStandard = {
  code: 'NAMES_0_2',
  functions: { resolve: RESOLVE, setRecord: SET_RECORD },
  vectors: [
    { fn: 'resolve', args: ['not a name!'], expect: invalid },
    { fn: 'resolve', args: ['vitalik.eth'], expect: { kind: 'shape' }, live: true },
    { fn: 'setRecord', args: ['not a name!', 'contenthash', CID], expect: invalid },
    { fn: 'setRecord', args: ['conformance.eth', 'contenthash', 'https://example.com'], expect: invalid },
    { fn: 'setRecord', args: ['conformance.eth', 'contenthash', `${CID}/index.html`], expect: invalid },
    { fn: 'setRecord', args: ['conformance.eth', 'contenthash', 'bzz://abcd'], expect: invalid },
    { fn: 'setRecord', args: ['conformance.eth', 'contenthash', ''], expect: invalid }
  ]
}

export interface Report { passed: number, ran: number, skipped: number, failed: { fn: string, reason: string }[] }

const breaksShape = (spec: FunctionSpec, args: readonly string[]): boolean => spec.args.some((arg, index) => {
  const value = args[index]
  return typeof value !== 'string' || (arg.maxLength !== undefined && value.length > arg.maxLength) || (arg.values !== undefined && !arg.values.includes(value))
})

/**
 * Runs the vectors of `standard` through `invoke`, as an install does. A vector that expects a shape is checked here only for an
 * answer that is an object: the shape of an answer is the browser's to hold the page to, and no vector of these two standards that
 * an install runs expects one.
 */
export async function runVectors (standard: NamesStandard, invoke: (fn: string, args: readonly string[]) => Promise<unknown>): Promise<Report> {
  const report: Report = { passed: 0, ran: 0, skipped: 0, failed: [] }
  for (const vector of standard.vectors) {
    const spec = standard.functions[vector.fn]
    if (spec === undefined) {
      report.ran += 1
      report.failed.push({ fn: vector.fn, reason: 'not a function of the module' })
      continue
    }
    if (vector.live === true) {
      report.skipped += 1
      continue
    }
    report.ran += 1
    const wanted = vector.expect
    if (breaksShape(spec, vector.args)) {
      if (wanted.kind === 'error' && wanted.code === 'invalid') report.passed += 1
      else report.failed.push({ fn: vector.fn, reason: 'the vector breaks the declared shape' })
      continue
    }
    try {
      const answer = await invoke(vector.fn, vector.args)
      if (wanted.kind === 'error') report.failed.push({ fn: vector.fn, reason: `answered, expected ${wanted.code}` })
      else if (typeof answer === 'object' && answer !== null) report.passed += 1
      else report.failed.push({ fn: vector.fn, reason: 'the answer is not an object' })
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (wanted.kind === 'error' && code === wanted.code) report.passed += 1
      else report.failed.push({ fn: vector.fn, reason: `rejected with ${typeof code === 'string' ? code : 'an error'}` })
    }
  }
  return report
}

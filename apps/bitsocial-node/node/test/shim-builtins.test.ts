// The objects registered in place of the builtins the shim does not give a run-time require.
import { describe, expect, it } from 'vitest'
import { streamWebFor, workerThreadsFor } from '../worker/workarounds/shim-builtins.js'

describe('workerThreadsFor', () => {
  const marker = Symbol('member')
  const members = ['Worker', 'isMainThread', 'threadId', 'parentPort', 'workerData', 'resourceLimits', 'SHARE_ENV', 'MessageChannel', 'MessagePort', 'BroadcastChannel', 'getEnvironmentData', 'setEnvironmentData', 'markAsUntransferable', 'isMarkedAsUntransferable']

  it('carries each member the shim has and gives markAsUncloneable, which it lacks, as one that does nothing', () => {
    const shim = Object.fromEntries(members.map((name) => [name, { name, marker }]))
    const registered = workerThreadsFor(shim)
    for (const name of members) expect((registered as Record<string, unknown>)[name]).toBe(shim[name])
    expect(registered.markAsUncloneable({})).toBeUndefined()
  })

  it('is a plain object, so an unknown member is undefined and feature detection works', () => {
    const registered = workerThreadsFor({}) as Record<string, unknown>
    expect(registered['somethingNew']).toBeUndefined()
    expect(Object.getPrototypeOf(registered)).toBe(Object.prototype)
  })
})

describe('streamWebFor', () => {
  it('takes the stream classes from the scope it is given', () => {
    const scope = { ReadableStream: class {}, WritableStream: class {}, TransformStream: class {} }
    const registered = streamWebFor(scope)
    expect(registered['ReadableStream']).toBe(scope.ReadableStream)
    expect(Object.keys(registered)).toContain('TextDecoderStream')
  })
})

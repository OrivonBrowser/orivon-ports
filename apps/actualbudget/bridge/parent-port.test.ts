// process.parentPort over a forked child's Node IPC channel: the two members upstream's backend uses.
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { installParentPort } from './parent-port.js'

function fakeProcess () {
  const proc = new EventEmitter() as EventEmitter & { send: (value: unknown) => void, parentPort?: unknown, sent: unknown[] }
  proc.sent = []
  proc.send = (value) => { proc.sent.push(value) }
  return proc
}

describe('process.parentPort', () => {
  it('hands the listener each message as { data }, the shape Electron\'s port delivers', () => {
    const proc = fakeProcess()
    const port = installParentPort(proc)
    const seen: unknown[] = []
    port.on('message', ({ data }: { data: unknown }) => { seen.push(data) })
    proc.emit('message', { id: 1, name: 'x', args: [] })
    expect(seen).toEqual([{ id: 1, name: 'x', args: [] }])
  })

  it('sends what postMessage is given over the IPC channel, unchanged', () => {
    const proc = fakeProcess()
    const port = installParentPort(proc)
    const value = { type: 'reply', id: 1, result: new Uint8Array([1]) }
    port.postMessage(value)
    expect(proc.sent[0]).toBe(value)
  })

  it('is installed on the process, and refuses an event the backend never listens for', () => {
    const proc = fakeProcess()
    const port = installParentPort(proc)
    expect(proc.parentPort).toBe(port)
    expect(() => port.on('exit', () => {})).toThrow(/'message' only/)
  })
})

// The status line: nothing for a quick start, a line after the delay, its text per phase, gone at ready or failure.
import { describe, expect, it } from 'vitest'
import { createStatusLine, statusText } from './status-line.js'

function fakeDoc () {
  const appended: any[] = []
  const makeNode = () => ({ id: '', textContent: '', style: { cssText: '' }, removed: false, setAttribute () {}, remove () { this.removed = true } })
  return { appended, doc: { createElement: () => makeNode(), documentElement: { append: (node: unknown) => { appended.push(node) } } } }
}

function fakeTimers () {
  const pending: Array<{ run: () => void, cleared: boolean }> = []
  return {
    pending,
    timers: {
      set: (run: () => void) => { const t = { run, cleared: false }; pending.push(t); return t },
      clear: (t: { cleared: boolean }) => { t.cleared = true }
    },
    fire: () => { for (const t of pending) if (!t.cleared) t.run() }
  }
}

describe('statusText', () => {
  it('says what is happening, and nothing for ready or failed', () => {
    expect(statusText({ phase: 'starting', done: 0, total: 0 })).toBe('Starting Actual…')
    expect(statusText({ phase: 'install', done: 3, total: 63 })).toBe('Setting up Actual on this device… (3 of 63 files)')
    expect(statusText({ phase: 'install', done: 0, total: 0 })).toBe('Setting up Actual on this device…')
    expect(statusText({ phase: 'ready', done: 0, total: 0 })).toBeNull()
    expect(statusText({ phase: 'failed', done: 0, total: 0 })).toBeNull()
  })
})

describe('createStatusLine', () => {
  it('shows nothing for a start that ends before the delay', () => {
    const { doc, appended } = fakeDoc()
    const clock = fakeTimers()
    const report = createStatusLine(doc, 1500, clock.timers as never)
    report({ phase: 'starting', done: 0, total: 0 })
    report({ phase: 'ready', done: 0, total: 0 })
    clock.fire()
    expect(appended).toHaveLength(0)
  })

  it('shows the line after the delay, follows the phases and goes at ready', () => {
    const { doc, appended } = fakeDoc()
    const clock = fakeTimers()
    const report = createStatusLine(doc, 1500, clock.timers as never)
    report({ phase: 'starting', done: 0, total: 0 })
    report({ phase: 'install', done: 1, total: 63 })
    clock.fire()
    expect(appended).toHaveLength(1)
    expect(appended[0].textContent).toBe('Setting up Actual on this device… (1 of 63 files)')
    report({ phase: 'install', done: 40, total: 63 })
    expect(appended[0].textContent).toBe('Setting up Actual on this device… (40 of 63 files)')
    report({ phase: 'ready', done: 0, total: 0 })
    expect(appended[0].removed).toBe(true)
  })

  it('goes at a failure too, leaving the renderer\'s own error screen alone', () => {
    const { doc, appended } = fakeDoc()
    const clock = fakeTimers()
    const report = createStatusLine(doc, 0, clock.timers as never)
    report({ phase: 'starting', done: 0, total: 0 })
    clock.fire()
    report({ phase: 'failed', done: 0, total: 0 })
    expect(appended[0].removed).toBe(true)
  })
})

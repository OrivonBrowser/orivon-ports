import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The unit tests run with no DOM: a node that keeps what `dom.js` sets is all `relayMark` needs.
class Node {
  attributes = new Map<string, string>()
  listeners = new Map<string, (event: unknown) => void>()
  children: Node[] = []
  className = ''
  textContent = ''
  constructor (readonly tag: string) {}
  setAttribute (name: string, value: string) { this.attributes.set(name, value) }
  addEventListener (name: string, handler: (event: unknown) => void) { this.listeners.set(name, handler) }
  append (...nodes: Node[]) { this.children.push(...nodes) }
  all (): Node[] { return [this, ...this.children.flatMap((child) => child.all())] }
}

const scope = globalThis as unknown as { document?: unknown }
const before = scope.document
beforeEach(() => { scope.document = { createElement: (tag: string) => new Node(tag) } })
afterEach(() => { scope.document = before })

describe('the private send switch\'s mark', () => {
  it('is the browser\'s own element, naming the relay the transactions go to, and not a look-alike drawn by the page', async () => {
    const { relayMark } = await import('../site/parts.js')
    const { RELAY } = await import('../site/relay.js')
    const row = relayMark() as unknown as Node
    const marks = row.all().filter((node) => node.tag === 'orivon-mark')
    expect(marks).toHaveLength(1)
    expect(marks[0]?.attributes.get('of')).toBe(RELAY.url)
    expect(marks[0]?.attributes.get('size')).toBe('s')
    expect(marks[0]?.children).toEqual([])
    expect(row.all().filter((node) => node.className.includes('mark'))).toEqual([])
  })

  it('keeps the plain word Web2 beside the mark, outside it, so the switch reads the same where the browser draws no verdict', async () => {
    const { relayMark } = await import('../site/parts.js')
    const row = relayMark() as unknown as Node
    expect(row.children.map((node) => node.tag)).toEqual(['span', 'orivon-mark'])
    expect(row.children[0]?.textContent).toBe('Web2')
  })

  it('does not let a press on the mark flip the switch it sits in', async () => {
    const { relayMark } = await import('../site/parts.js')
    const mark = (relayMark() as unknown as Node).all().find((node) => node.tag === 'orivon-mark')
    let prevented = false
    mark?.listeners.get('click')?.({ preventDefault: () => { prevented = true } })
    expect(prevented).toBe(true)
  })
})

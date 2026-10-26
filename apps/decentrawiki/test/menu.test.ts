import { afterEach, describe, expect, it } from 'vitest'

/** The few parts of an element and of the document that the menu touches. */
class FakeNode {
  children: unknown[] = []
  attrs: Record<string, string> = {}
  listeners: Record<string, Array<(event: unknown) => void>> = {}
  style: Record<string, string> = {}
  offsetWidth = 120
  removed = false
  focused = false
  constructor (public tag: string) {}
  setAttribute (name: string, value: string): void { this.attrs[name] = value }
  addEventListener (type: string, listener: (event: unknown) => void): void { (this.listeners[type] ??= []).push(listener) }
  append (...nodes: unknown[]): void { this.children.push(...nodes) }
  remove (): void { this.removed = true }
  focus (): void { this.focused = true }
  contains (node: unknown): boolean { return node === this || this.children.includes(node) }
  getBoundingClientRect (): { bottom: number, right: number } { return { bottom: 10, right: 200 } }
  querySelector (selector: string): FakeNode | null {
    const items = this.children.filter((child): child is FakeNode => child instanceof FakeNode && child.attrs['class']?.split(' ').includes(selector.slice(1)) === true)
    return items[0] ?? null
  }
}

function installDom (): { appended: FakeNode[] } {
  const appended: FakeNode[] = []
  const g = globalThis as Record<string, unknown>
  g['Node'] = FakeNode
  g['document'] = {
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    body: { append: (node: FakeNode) => appended.push(node) },
    addEventListener: () => {},
    removeEventListener: () => {}
  }
  g['window'] = { scrollX: 0, scrollY: 0, innerWidth: 1000, addEventListener: () => {}, removeEventListener: () => {} }
  return { appended }
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>
  delete g['document']
  delete g['window']
  delete g['Node']
})

describe('the pop-up menu', () => {
  it('opens beside its button, focuses the first item and runs the chosen item', async () => {
    const { appended } = installDom()
    const { openMenu } = await import('../page/src/ui/menu.js')
    const anchor = new FakeNode('button')
    let chosen = ''
    openMenu(anchor as never, [{ label: 'Open', onSelect: () => { chosen = 'open' } }, { label: 'Delete', danger: true, onSelect: () => { chosen = 'delete' } }])
    const menu = appended[0]!
    expect(anchor.attrs['aria-expanded']).toBe('true')
    expect(menu.style['top']).toBe('16px')
    const items = menu.children as FakeNode[]
    expect(items).toHaveLength(2)
    expect(items[0]!.focused).toBe(true)
    items[1]!.listeners['click']![0]!({})
    expect(chosen).toBe('delete')
    expect(menu.removed).toBe(true)
    expect(anchor.attrs['aria-expanded']).toBe('false')
  })
})

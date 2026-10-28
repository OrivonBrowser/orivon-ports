// The few parts of a document the editor's views are built with (page/src/dom.js): elements that keep their
// attributes, children, listeners and a few properties, so a test can read what a view drew and press its
// buttons. A test file installs it around its tests with installFakeDom and removeFakeDom.

export class FakeNode {}
export class FakeText extends FakeNode {
  constructor (public data: string) { super() }
}
export class FakeElement extends FakeNode {
  children: FakeNode[] = []
  attrs: Record<string, string> = {}
  listeners: Record<string, Array<(event: unknown) => void>> = {}
  private chosen: string | undefined
  checkedNow: boolean | undefined
  constructor (public tag: string) { super() }
  setAttribute (name: string, value: string): void { this.attrs[name] = value }
  getAttribute (name: string): string | null { return this.attrs[name] ?? null }
  hasAttribute (name: string): boolean { return name in this.attrs }
  removeAttribute (name: string): void { delete this.attrs[name] }
  addEventListener (type: string, listener: (event: unknown) => void): void { (this.listeners[type] ??= []).push(listener) }
  fire (type: string): void { for (const listener of this.listeners[type] ?? []) listener({ target: this, preventDefault () {} }) }
  append (...nodes: Array<FakeNode | string>): void { this.children.push(...nodes.map((node) => typeof node === 'string' ? new FakeText(node) : node)) }
  replaceChildren (...nodes: Array<FakeNode | string>): void { this.children = []; this.append(...nodes) }
  get className (): string { return this.attrs['class'] ?? '' }
  set className (value: string) { this.attrs['class'] = value }
  get classList () { return { add: () => {}, remove: () => {}, toggle: () => {} } }
  get dataset (): Record<string, string> { return {} }
  get textContent (): string { return this.children.map((child) => child instanceof FakeText ? child.data : (child as FakeElement).textContent).join('') }
  set textContent (value: string) { this.children = [new FakeText(value)] }
  get checked (): boolean { return this.checkedNow ?? this.hasAttribute('checked') }
  set checked (value: boolean) { this.checkedNow = value }
  get value (): string {
    if (this.chosen !== undefined) return this.chosen
    return this.tag === 'select' ? (this.all('option')[0]?.attrs['value'] ?? '') : this.attrs['value'] ?? ''
  }
  set value (value: string) { this.chosen = value }
  all (tag: string): FakeElement[] {
    const found: FakeElement[] = []
    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue
      if (child.tag === tag) found.push(child)
      found.push(...child.all(tag))
    }
    return found
  }
  find (text: string): FakeElement[] {
    return this.all('button').concat(this.all('a')).filter((el) => el.textContent.includes(text))
  }
}

const globals = globalThis as Record<string, unknown>

export function installFakeDom (): void {
  globals['Node'] = FakeNode
  globals['window'] = {}
  globals['document'] = { createElement: (tag: string) => new FakeElement(tag), createElementNS: (_ns: string, tag: string) => new FakeElement(tag) }
}

export function removeFakeDom (): void {
  delete globals['Node']
  delete globals['window']
  delete globals['document']
}

/** The elements a view returned, under one root, in the order given. */
export function show (nodes: unknown[]): FakeElement {
  const root = new FakeElement('div')
  root.append(...(nodes.flat(Infinity).filter((node) => node !== null && node !== undefined) as FakeNode[]))
  return root
}

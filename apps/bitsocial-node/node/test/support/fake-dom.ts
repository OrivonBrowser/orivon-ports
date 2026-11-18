// The few parts of a document the dashboard's modules build with, so their tests draw into something they can read: elements with
// children, attributes, text, a value, listeners that a test fires, and a `querySelector` for the shapes the tests use
// (`tag`, `.class`, `#id`, `[name]`, `[name="value"]`, those joined with no space between them, and a space for "somewhere below").

export class FakeText {
  constructor (public text: string) {}
  get textContent (): string { return this.text }
}

type Listener = (event: FakeEvent) => void
export interface FakeEvent { type: string, target: FakeElement, prevented: boolean, preventDefault: () => void }

export class FakeElement {
  children: Array<FakeElement | FakeText> = []
  parent: FakeElement | null = null
  attributes = new Map<string, string>()
  listeners = new Map<string, Listener[]>()
  className = ''
  value = ''
  checked = false
  constructor (public tagName: string) {}

  /** `hidden` and `disabled` are attributes a page also reads and sets as properties. */
  get hidden (): boolean { return this.attributes.has('hidden') }
  set hidden (on: boolean) { if (on) this.attributes.set('hidden', ''); else this.attributes.delete('hidden') }
  get disabled (): boolean { return this.attributes.has('disabled') }
  set disabled (on: boolean) { if (on) this.attributes.set('disabled', ''); else this.attributes.delete('disabled') }

  get id (): string { return this.attributes.get('id') ?? '' }
  setAttribute (name: string, value: string): void { this.attributes.set(name, String(value)) }
  removeAttribute (name: string): void { this.attributes.delete(name) }
  getAttribute (name: string): string | null { return this.attributes.get(name) ?? null }

  append (...nodes: Array<FakeElement | FakeText | string>): void {
    for (const node of nodes) {
      const made = typeof node === 'string' ? new FakeText(node) : node
      if (made instanceof FakeElement) { made.remove(); made.parent = this }
      this.children.push(made)
    }
  }

  remove (): void {
    if (this.parent === null) return
    this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }

  get textContent (): string { return this.children.map((child) => child.textContent).join('') }
  set textContent (text: string) {
    for (const child of this.children) if (child instanceof FakeElement) child.parent = null
    this.children = text === '' ? [] : [new FakeText(text)]
  }

  addEventListener (type: string, listener: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }

  /** Fires the listeners of `type` and tells whether one of them prevented the default. */
  dispatch (type: string): boolean {
    const event: FakeEvent = { type, target: this, prevented: false, preventDefault () { event.prevented = true } }
    for (const listener of this.listeners.get(type) ?? []) listener(event)
    return event.prevented
  }

  /** What a person does: a value typed into an input, then the event the page hears. */
  type (text: string): void { this.value = text; this.dispatch('input') }
  click (): void { if (!this.disabled) this.dispatch('click') }

  /** Every element under this one, in document order. */
  descendants (): FakeElement[] {
    return this.children.flatMap((child) => (child instanceof FakeElement ? [child, ...child.descendants()] : []))
  }

  /** One element's own part of a selector: every piece of the compound must hold for this element. */
  private matchesCompound (selector: string): boolean {
    return [...selector.matchAll(/([#.][\w-]+)|(\[[\w-]+(?:="[^"]*")?\])|([a-zA-Z][\w-]*)/g)].every(([part]) => {
      if (part!.startsWith('#')) return this.id === part!.slice(1)
      if (part!.startsWith('.')) return this.className.split(/\s+/).includes(part!.slice(1))
      if (part!.startsWith('[')) {
        const [, name, value] = /\[([\w-]+)(?:="([^"]*)")?\]/.exec(part!)!
        return value === undefined ? this.attributes.has(name!) : this.attributes.get(name!) === value
      }
      return this.tagName.toLowerCase() === part!.toLowerCase()
    })
  }

  /** A selector of compounds separated by spaces: this element matches the last, and an element above it matches each earlier one in order. */
  matches (selector: string): boolean {
    const compounds = selector.trim().split(/\s+/)
    if (!this.matchesCompound(compounds.pop()!)) return false
    let above: FakeElement | null = this.parent
    while (compounds.length > 0) {
      while (above !== null && !above.matchesCompound(compounds.at(-1)!)) above = above.parent
      if (above === null) return false
      compounds.pop()
      above = above.parent
    }
    return true
  }

  querySelectorAll (selector: string): FakeElement[] { return this.descendants().filter((element) => element.matches(selector)) }
  querySelector (selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null }
}

export class FakeDocument {
  createElement (tag: string): FakeElement { return new FakeElement(tag) }
}

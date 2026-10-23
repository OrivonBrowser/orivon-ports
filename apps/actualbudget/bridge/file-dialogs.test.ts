// The two dialogs over Orivon's pickers: a picked file is a handle (never a path), a folder is
// refused, a save writes into a picked folder by a safe name, and a refusal for want of a click
// shows a button of the page's own whose click picks.
import { describe, expect, it } from 'vitest'
import { pickFiles, saveToPickedFolder } from './file-dialogs.js'

class FakeElement {
  children: FakeElement[] = []
  attributes: Record<string, string> = {}
  listeners: Record<string, Array<() => void>> = {}
  style: { cssText: string } = { cssText: '' }
  textContent = ''
  type = ''
  id = ''
  removed = false
  constructor (readonly tag: string) {}
  setAttribute (name: string, value: string): void { this.attributes[name] = value }
  addEventListener (type: string, listener: () => void): void { (this.listeners[type] ??= []).push(listener) }
  append (...children: FakeElement[]): void { this.children.push(...children) }
  remove (): void { this.removed = true }
  click (): void { for (const listener of this.listeners['click'] ?? []) listener() }
  find (text: string): FakeElement | undefined {
    if (this.textContent === text) return this
    for (const child of this.children) { const found = child.find(text); if (found !== undefined) return found }
    return undefined
  }
}

function fakeDocument () {
  const body = new FakeElement('body')
  return { body, doc: { body, createElement: (tag: string) => new FakeElement(tag), getElementById: (id: string) => body.children.find((child) => child.id === id && !child.removed) } }
}

const folder = () => {
  const written: Array<[string, Uint8Array]> = []
  return { written, handle: { writeFile: async (name: string, bytes: Uint8Array) => { written.push([name, bytes]) } } }
}

describe('pickFiles', () => {
  it('asks the picker for one file by default and returns the handles', async () => {
    const calls: unknown[] = []
    const handle = { name: 'a.zip' }
    const orivon = { fs: { userSelected: async (options: unknown) => { calls.push(options); return [handle] } } }
    expect(await pickFiles(orivon, { properties: ['openFile'] })).toEqual([handle])
    expect(calls).toEqual([{ multiple: false }])
  })

  it('asks for several when the app does', async () => {
    const calls: unknown[] = []
    const orivon = { fs: { userSelected: async (options: unknown) => { calls.push(options); return [{}, {}] } } }
    await pickFiles(orivon, { properties: ['openFile', 'multiSelections'] })
    expect(calls).toEqual([{ multiple: true }])
  })

  it('resolves undefined when the person cancelled, as Electron\'s dialog does', async () => {
    const orivon = { fs: { userSelected: async () => [] } }
    expect(await pickFiles(orivon, undefined)).toBeUndefined()
  })

  it('refuses a folder pick by name and never opens the picker', async () => {
    const orivon = { fs: { userSelected: async () => { throw new Error('must not open') } } }
    await expect(pickFiles(orivon, { properties: ['openDirectory'] })).rejects.toMatchObject({ name: 'OrivonBridgeError', message: expect.stringContaining('folders cannot be chosen') })
  })
})

describe('saveToPickedFolder', () => {
  it('writes the bytes into the picked folder under a safe name', async () => {
    const f = folder()
    const { doc } = fakeDocument()
    const ok = await saveToPickedFolder({ orivon: { fs: { userSelected: async () => f.handle } }, doc }, 'hello', '../x/2026-10-01-budget.zip', 'Export budget')
    expect(ok).toBe(true)
    expect(f.written[0]?.[0]).toBe('2026-10-01-budget.zip')
    expect(new TextDecoder().decode(f.written[0]?.[1])).toBe('hello')
  })

  it('resolves false and writes nothing when the person cancels the picker', async () => {
    const { doc } = fakeDocument()
    expect(await saveToPickedFolder({ orivon: { fs: { userSelected: async () => null } }, doc }, 'x', 'a.csv')).toBe(false)
  })

  it('passes any other failure on', async () => {
    const { doc } = fakeDocument()
    const orivon = { fs: { userSelected: async () => { throw Object.assign(new Error('quota'), { code: 'limit' }) } } }
    await expect(saveToPickedFolder({ orivon, doc }, 'x', 'a.csv')).rejects.toThrow('quota')
  })

  it('shows a button when the page had no recent click, and picks inside its click', async () => {
    const f = folder()
    const { doc, body } = fakeDocument()
    let calls = 0
    const orivon = {
      fs: {
        userSelected: async () => {
          calls++
          if (calls === 1) throw Object.assign(new Error('no activation'), { code: 'denied' })
          return f.handle
        }
      }
    }
    const done = saveToPickedFolder({ orivon, doc }, 'data', 'budget.zip', 'Export budget')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const prompt = body.children[0]
    expect(prompt?.attributes['role']).toBe('dialog')
    expect(prompt?.find('Export budget: budget.zip is ready. Choose the folder to save it in.')).toBeDefined()
    expect(calls).toBe(1)
    prompt?.find('Choose a folder')?.click()
    expect(await done).toBe(true)
    expect(calls).toBe(2)
    expect(prompt?.removed).toBe(true)
    expect(f.written[0]?.[0]).toBe('budget.zip')
  })

  it('resolves false when the person cancels the button\'s prompt', async () => {
    const { doc, body } = fakeDocument()
    const orivon = { fs: { userSelected: async () => { throw Object.assign(new Error('no activation'), { code: 'denied' }) } } }
    const done = saveToPickedFolder({ orivon, doc }, 'data', 'budget.zip')
    await new Promise((resolve) => setTimeout(resolve, 0))
    body.children[0]?.find('Cancel')?.click()
    expect(await done).toBe(false)
  })

  it('rejects when the prompt\'s own pick fails', async () => {
    const { doc, body } = fakeDocument()
    const orivon = { fs: { userSelected: async () => { throw Object.assign(new Error('no'), { code: 'denied' }) } } }
    const done = saveToPickedFolder({ orivon, doc }, 'data', 'budget.zip')
    await new Promise((resolve) => setTimeout(resolve, 0))
    body.children[0]?.find('Choose a folder')?.click()
    await expect(done).rejects.toThrow('no')
  })

  it('refuses contents that are neither text nor bytes before asking for a folder', async () => {
    const { doc } = fakeDocument()
    const orivon = { fs: { userSelected: async () => { throw new Error('must not open') } } }
    await expect(saveToPickedFolder({ orivon, doc }, 42, 'a.csv')).rejects.toThrow(TypeError)
  })
})

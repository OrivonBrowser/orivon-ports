// How a note's embedded files are shown: the address upstream's preload makes, and the one it is
// replaced with, run against a stand-in for the page.
import { describe, expect, it } from 'vitest'
import { assetPath, typeOf, watchAssets } from './assets.js'

describe('assetPath', () => {
  it('reads the file out of the address the preload makes', () => {
    expect(assetPath(`zen-asset://local?path=${encodeURIComponent('/orivon/picked/ab12/assets/my photo.png')}`)).toBe('/orivon/picked/ab12/assets/my photo.png')
  })

  it('answers null for any other address, and for one it cannot decode', () => {
    for (const other of ['https://example.org/a.png', 'zen-theme://slug/font.woff2', 'blob:http://x/1', '', null, undefined]) expect(assetPath(other as string), String(other)).toBeNull()
    expect(assetPath('zen-asset://local?path=%E0%A4%A')).toBeNull()
  })
})

describe('typeOf', () => {
  it('names the types a note embeds, whatever the case, and no other', () => {
    expect(typeOf('/a/b.PNG')).toBe('image/png')
    expect(typeOf('c.svg')).toBe('image/svg+xml')
    expect(typeOf('talk.m4a')).toBe('audio/mp4')
    expect(typeOf('clip.mp4')).toBe('video/mp4')
    expect(typeOf('data.csv')).toBe('application/octet-stream')
    expect(typeOf('no-extension')).toBe('application/octet-stream')
  })
})

describe('watchAssets', () => {
  function element (src: string) {
    const attributes = new Map([['src', src]])
    return { getAttribute: (name: string) => attributes.get(name) ?? null, setAttribute: (name: string, value: string) => { attributes.set(name, value) }, src: () => attributes.get('src') }
  }
  const page = (...found: Array<ReturnType<typeof element>>) => ({ querySelectorAll: () => found })
  const address = (path: string) => `zen-asset://local?path=${encodeURIComponent(path)}`

  it('gives each element a blob address of the file\'s bytes, typed by its extension', async () => {
    const image = element(address('/orivon/picked/ab12/assets/a.png'))
    const made: Array<{ size: number, type: string }> = []
    watchAssets({ root: page(image), observe: false, read: async () => Buffer.from([1, 2, 3]), createUrl: (blob) => { made.push({ size: blob.size, type: blob.type }); return 'blob:made/1' } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(image.src()).toBe('blob:made/1')
    expect(made).toEqual([{ size: 3, type: 'image/png' }])
  })

  it('reads a file once for every element that names it', async () => {
    const [a, b] = [element(address('/p/x.png')), element(address('/p/x.png'))]
    let reads = 0
    watchAssets({ root: page(a, b), observe: false, read: async () => { reads += 1; return Buffer.alloc(1) }, createUrl: () => 'blob:made/2' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect([a.src(), b.src(), reads]).toEqual(['blob:made/2', 'blob:made/2', 1])
  })

  it('leaves an address it cannot read, and says why', async () => {
    const image = element(address('/p/gone.png'))
    const warnings: unknown[][] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    try {
      watchAssets({ root: page(image), observe: false, read: async () => { throw new Error('ENOENT') }, createUrl: () => 'blob:never' })
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      console.warn = warn
    }
    expect(image.src()).toBe(address('/p/gone.png'))
    expect(String(warnings[0]?.[0])).toContain('/p/gone.png')
  })

  it('does not touch an element whose address is not a note\'s asset', async () => {
    const other = element('https://example.org/a.png')
    watchAssets({ root: page(other), observe: false, read: async () => { throw new Error('read') }, createUrl: () => 'blob:never' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(other.src()).toBe('https://example.org/a.png')
  })
})

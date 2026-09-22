// The catalog, exercised through the composer and a real realm -- the same
// path a port takes, so a behaviour that only works when it is called
// directly is not a behaviour that passed here.
import { describe, expect, it, vi } from 'vitest'
import { runDeclaration } from '../testing/bridge-harness.ts'
import { CATALOG, SINGLE_ROLE } from './catalog.ts'

function named (id: string, names: Record<string, string> | string): Record<string, unknown> {
  return { global: 'app', behaviours: { [id]: names } }
}

describe('fullscreen', () => {
  it('calls requestFullscreen on the document element', async () => {
    const requestFullscreen = vi.fn(async () => {})
    const { bridge } = await runDeclaration(named('fullscreen', 'goFullscreen'), {
      document: { documentElement: { style: {}, requestFullscreen } }
    })
    await bridge.goFullscreen()
    expect(requestFullscreen).toHaveBeenCalledTimes(1)
  })

  it('still surfaces a rejection to a caller who awaits it', async () => {
    const requestFullscreen = vi.fn(async () => { throw new Error('denied') })
    const { bridge } = await runDeclaration(named('fullscreen', 'goFullscreen'), {
      document: { documentElement: { style: {}, requestFullscreen } }
    })
    await expect(bridge.goFullscreen()).rejects.toThrow('denied')
  })
})

describe('pictureInPicture', () => {
  it('uses the first <video> on the page', async () => {
    const requestPictureInPicture = vi.fn(async () => {})
    const { bridge } = await runDeclaration(named('pictureInPicture', 'pip'), {
      document: { querySelector: () => ({ requestPictureInPicture }) }
    })
    await bridge.pip()
    expect(requestPictureInPicture).toHaveBeenCalledTimes(1)
  })

  it('resolves quietly when no <video> is mounted yet', async () => {
    const { bridge } = await runDeclaration(named('pictureInPicture', 'pip'))
    await expect(bridge.pip()).resolves.toBeUndefined()
  })
})

describe('zoom and locale', () => {
  it('zoom writes the CSS zoom style as a string', async () => {
    const { bridge, sandbox } = await runDeclaration(named('zoom', 'setZoom'))
    bridge.setZoom(1.25)
    expect(sandbox.document.documentElement.style['zoom']).toBe('1.25')
  })

  it('locale answers navigator.language', async () => {
    const { bridge } = await runDeclaration(named('locale', 'getLocale'), { navigator: { language: 'fr-CA' } })
    expect(bridge.getLocale()).toBe('fr-CA')
  })
})

describe('wakeLock', () => {
  const declaration = named('wakeLock', { acquire: 'keepAwake', release: 'letSleep' })

  it('requests a screen lock and releases the one it holds', async () => {
    const release = vi.fn(async () => {})
    const request = vi.fn(async () => ({ release }))
    const { bridge } = await runDeclaration(declaration, { navigator: { wakeLock: { request } } })
    await bridge.keepAwake()
    expect(request).toHaveBeenCalledWith('screen')
    await bridge.letSleep()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('degrades quietly where the API does not exist, and releasing holds nothing', async () => {
    const { bridge } = await runDeclaration(declaration)
    await expect(bridge.keepAwake()).resolves.toBeUndefined()
    await expect(bridge.letSleep()).resolves.toBeUndefined()
  })

  it('releases only once, so a second release does not reach a stale sentinel', async () => {
    const release = vi.fn(async () => {})
    const { bridge } = await runDeclaration(declaration, { navigator: { wakeLock: { request: async () => ({ release }) } } })
    await bridge.keepAwake()
    await bridge.letSleep()
    await bridge.letSleep()
    expect(release).toHaveBeenCalledTimes(1)
  })
})

describe('memoryCache', () => {
  it('round-trips through a Map that starts empty', async () => {
    const { bridge } = await runDeclaration(named('memoryCache', { get: 'cacheGet', set: 'cacheSet' }))
    expect(await bridge.cacheGet('k')).toBeUndefined()
    await bridge.cacheSet('k', { url: 'https://example.test' })
    expect(await bridge.cacheGet('k')).toEqual({ url: 'https://example.test' })
  })
})

describe('pickedFolderDownloads', () => {
  const declaration = named('pickedFolderDownloads', { choose: 'pickFolder', write: 'writeFile' })

  it('refuses by name when there is no fs grant', async () => {
    const { bridge } = await runDeclaration(declaration, { orivon: {} })
    await expect(bridge.pickFolder()).rejects.toMatchObject({ name: 'OrivonBridgeError', reason: 'not-built' })
  })

  it('resolves false before a folder has been chosen', async () => {
    const { bridge } = await runDeclaration(declaration, { orivon: { fs: {} } })
    await expect(bridge.writeFile('a.txt', new Uint8Array([1]))).resolves.toBe(false)
  })

  it('writes into the folder the user picked, by name, and never exposes the handle', async () => {
    const writeFile = vi.fn(async () => {})
    const userSelected = vi.fn(async () => ({ writeFile }))
    const { bridge } = await runDeclaration(declaration, { orivon: { fs: { userSelected } } })

    await expect(bridge.pickFolder()).resolves.toBeUndefined()
    expect(userSelected).toHaveBeenCalledWith({ directory: true })
    await expect(bridge.writeFile('clip.mp4', new Uint8Array([1, 2]))).resolves.toBe(true)
    expect(writeFile).toHaveBeenCalledWith('clip.mp4', new Uint8Array([1, 2]))
  })

  it('reads the grant at the call, so one that arrives later works', async () => {
    const { bridge, sandbox } = await runDeclaration(declaration, { orivon: {} })
    await expect(bridge.pickFolder()).rejects.toThrow('no fs grant')
    sandbox.window.orivon = { fs: { userSelected: async () => ({ writeFile: async () => {} }) } }
    await expect(bridge.pickFolder()).resolves.toBeUndefined()
  })
})

describe('the catalog and its runtime', () => {
  // catalog.ts is what validates a declaration and runtime/behaviours.js is
  // what implements it. An id in one and not the other is a port that passes
  // validation and then throws at the first script in <head>, so every id is
  // composed and run here rather than compared by name.
  it('implements every id it declares, installing exactly one member per role', async () => {
    for (const [id, spec] of Object.entries(CATALOG)) {
      const names = spec.roles.length === 1
        ? { [SINGLE_ROLE]: 'only' }
        : Object.fromEntries(spec.roles.map((role, index) => [role, `member${String(index)}`]))
      const { bridge } = await runDeclaration(named(id, spec.roles.length === 1 ? 'only' : names), { orivon: { fs: {} } })
      expect(Object.keys(bridge).sort()).toEqual(Object.values(names).sort())
    }
  })
})

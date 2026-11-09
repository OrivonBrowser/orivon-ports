// The renderer gate: Ledger's renderer reads `process` while it loads and Orivon
// installs it only in an app tab, so the bridge (which runs first, while the
// page is still being parsed) adds the renderer's script only when `process`
// exists, after the obfuscated store is read into the bootstrap the renderer
// reads synchronously; otherwise it puts a message on the page.
import { createCipheriv, pbkdf2Sync, randomBytes, webcrypto } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { bridgeSourceFor, runBridge } from '../../../src/testing/bridge-harness.ts'
import { transformHtml } from '../hooks.mjs'

const source = await bridgeSourceFor('ledger-wallet')
const TAG = '<script defer src="./renderer.bundle.js"></script>'
const NOTE = 'Ledger Wallet is waiting for Orivon. Allow it when Orivon asks. If Orivon does not ask, update Orivon to the latest version, then reload.'

interface Appended { tag?: string, src?: string, textContent?: string, style: Record<string, string> }

function page (options: { process: boolean, body: boolean, store?: Uint8Array | undefined, fsFails?: boolean }) {
  const appended: Appended[] = []
  const listeners: Array<{ type: string, listener: () => void }> = []
  const document = {
    title: 'Ledger Wallet',
    baseURI: 'http://127.0.0.1/',
    readyState: 'loading',
    getElementById: () => null,
    addEventListener: (type: string, listener: () => void) => { listeners.push({ type, listener }) },
    documentElement: { style: {}, requestFullscreen: async () => {}, appendChild: (node: Appended) => { appended.push(node) } },
    querySelector: () => null,
    createElement: (tag: string) => ({ tag, style: {} as Record<string, string> }),
    body: options.body ? { appendChild: (node: Appended) => { appended.push(node) } } : null
  }
  const orivon = options.fsFails === true
    ? { fs: { readFile: async () => { throw new Error('the file store is unreachable') } } }
    : { fs: { readFile: async () => { if (options.store === undefined) throw Object.assign(new Error('not found'), { code: 'notFound' }); return options.store } } }
  const loaded = runBridge(source, {
    orivon,
    document: document as never,
    navigator: { clipboard: { writeText: async () => {} } } as never,
    globals: { crypto: webcrypto, structuredClone, atob, btoa, Blob, location: { reload: vi.fn() }, console, ...(options.process ? { process: { versions: {} } } : {}) }
  })
  return { appended, listeners, loaded, ready: loaded.app['ready'] as Promise<boolean> }
}

describe('the renderer gate', () => {
  it('adds the renderer script, as a script the page loads from its own folder, when the page has process', async () => {
    const { appended, ready } = page({ process: true, body: true })
    expect(await ready).toBe(true)
    expect(appended).toEqual([{ tag: 'script', src: './renderer.bundle.js', style: {} }])
  })

  it('adds the renderer to the document element while the parser has not reached the body', async () => {
    const { appended, ready } = page({ process: true, body: false })
    await ready
    expect(appended.map((node) => node.src)).toEqual(['./renderer.bundle.js'])
  })

  it('has the store in the bootstrap before the renderer script is added', async () => {
    const iv = randomBytes(16)
    const key = pbkdf2Sync('this_only_obfuscates', iv.toString(), 10000, 32, 'sha512')
    const cipher = createCipheriv('aes-256-cbc', key, iv)
    const store = Buffer.concat([iv, Buffer.from(':'), cipher.update(JSON.stringify({ app: { language: 'it' } }), 'utf8'), cipher.final()])
    const { appended, loaded, ready } = page({ process: true, body: true, store })
    expect(appended).toEqual([])
    await ready
    expect(appended).toHaveLength(1)
    expect(loaded.globals['lld']!.bridge['bootstrap'].store).toEqual({ app: { language: 'it' } })
  })

  it('still starts the renderer when the file store cannot be read', async () => {
    const { appended, loaded, ready } = page({ process: true, body: true, fsFails: true })
    await ready
    expect(appended).toHaveLength(1)
    expect(loaded.globals['lld']!.bridge['bootstrap'].store).toEqual({})
  })

  it('adds nothing and says what is missing when process is absent and the body exists', async () => {
    const { appended, ready } = page({ process: false, body: true })
    expect(await ready).toBe(false)
    expect(appended).toHaveLength(1)
    expect(appended[0]!.textContent).toBe(NOTE)
  })

  it('waits for the parser to reach the body before showing the message', async () => {
    const { appended, listeners, ready } = page({ process: false, body: false })
    await ready
    expect(appended).toEqual([])
    expect(listeners.find((entry) => entry.type === 'DOMContentLoaded')).toBeDefined()
  })
})

describe('the HTML hook', () => {
  const html = `<html><head></head><body><div id="react-root"></div>${TAG}</body></html>`

  it('takes the static renderer tag out and is idempotent', () => {
    const once = transformHtml(html)
    expect(once).not.toContain('renderer.bundle.js')
    expect(transformHtml(once)).toBe(once)
  })

  it('takes the bundler workaround script out', () => {
    expect(transformHtml(`<script>var parcelRequire</script>${html}`)).not.toContain('parcelRequire')
  })

  it('fails the build when the renderer tag is not where the gate expects it', () => {
    expect(() => transformHtml('<html><head></head><body></body></html>')).toThrow(/renderer gate/)
  })
})

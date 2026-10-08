// The renderer gate: Ledger's renderer reads `process` while it loads and Orivon
// installs it only in an app tab, so the bridge (which runs first, while the
// page is still being parsed) writes the renderer's script tag only when
// `process` exists, and otherwise puts a message on the page.
import { webcrypto } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { bridgeSourceFor, runBridge } from '../../../src/testing/bridge-harness.ts'
import { transformHtml } from '../hooks.mjs'

const source = await bridgeSourceFor('ledger-wallet')
const TAG = '<script defer src="./renderer.bundle.js"></script>'

function parsingPage (globals: Record<string, unknown>, bodyExists: boolean) {
  const written: string[] = []
  const appended: Array<{ textContent?: string, style: Record<string, string> }> = []
  const listeners: Array<{ type: string, listener: () => void }> = []
  const document = {
    title: 'Ledger Wallet',
    baseURI: 'http://127.0.0.1/',
    readyState: 'loading',
    getElementById: () => null,
    addEventListener: (type: string, listener: () => void) => { listeners.push({ type, listener }) },
    documentElement: { style: {}, requestFullscreen: async () => {} },
    querySelector: () => null,
    write: (html: string) => { written.push(html) },
    createElement: () => ({ style: {} as Record<string, string> }),
    body: bodyExists ? { appendChild: (node: { textContent?: string, style: Record<string, string> }) => { appended.push(node) } } : null
  }
  runBridge(source, {
    document: document as never,
    navigator: { clipboard: { writeText: async () => {} } } as never,
    globals: { crypto: webcrypto, structuredClone, atob, btoa, Blob, location: { reload: vi.fn() }, console, ...globals }
  })
  return { written, appended, listeners }
}

describe('the renderer gate', () => {
  it('writes the renderer script, as upstream spells it, when the page has process', () => {
    const { written, appended } = parsingPage({ process: { versions: {} } }, false)
    expect(written).toEqual([TAG])
    expect(appended).toEqual([])
  })

  it('writes nothing and says what is missing when process is absent and the body exists', () => {
    const { written, appended } = parsingPage({}, true)
    expect(written).toEqual([])
    expect(appended).toHaveLength(1)
    expect(appended[0]!.textContent).toBe('Ledger Wallet is waiting for Orivon. Allow it when Orivon asks. If Orivon does not ask, update Orivon to the latest version, then reload.')
  })

  it('waits for the parser to reach the body before showing the message', () => {
    const { written, listeners } = parsingPage({}, false)
    expect(written).toEqual([])
    const ready = listeners.find((entry) => entry.type === 'DOMContentLoaded')
    expect(ready).toBeDefined()
  })

  it('leaves a document that is no longer parsing alone', () => {
    const written: string[] = []
    runBridge(source, {
      document: { readyState: 'complete', write: (html: string) => { written.push(html) } } as never,
      globals: { crypto: webcrypto, structuredClone, atob, btoa, Blob, location: { reload: vi.fn() }, console, process: {} }
    })
    expect(written).toEqual([])
  })
})

describe('the HTML hook', () => {
  const page = `<html><head></head><body><div id="react-root"></div>${TAG}</body></html>`

  it('takes the static renderer tag out and is idempotent', () => {
    const once = transformHtml(page)
    expect(once).not.toContain('renderer.bundle.js')
    expect(transformHtml(once)).toBe(once)
  })

  it('fails the build when the renderer tag is not where the gate expects it', () => {
    expect(() => transformHtml('<html><head></head><body></body></html>')).toThrow(/renderer gate/)
  })
})

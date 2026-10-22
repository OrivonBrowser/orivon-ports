// The prepare-time rewrite of the built index.html: the one inline script moves out of the
// document, because the shell's CSP admits no inline script.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SHIM_FILE, transformHtml } from '../hooks.mjs'

// The shape of upstream's inline shim, as its index.html carries it.
const SHIM = 'globalThis.process=globalThis.process||{};process.nextTick=process.nextTick||(function(cb){var a=Array.prototype.slice.call(arguments,1);queueMicrotask(function(){cb.apply(null,a)})});'

function builtIndex (): string {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8" /><title>Fluux Messenger</title>' +
    '<script type="module" crossorigin src="./assets/main-abc.js"></script></head><body>' +
    `<script>${SHIM}</script><div id="root"></div></body></html>`
}

describe('prepare-time rewrite (hooks.mjs)', () => {
  let dirs: { static: string }

  beforeEach(async () => { dirs = { static: await mkdtemp(join(tmpdir(), 'fluux-hooks-')) } })
  afterEach(async () => { await rm(dirs.static, { recursive: true, force: true }) })

  it('leaves no inline script in the document and loads the shim from a file, in the same place', async () => {
    const html = await transformHtml(builtIndex(), { dirs })
    expect(html).not.toMatch(/<script>/)
    expect(html).toContain(`<script src="${SHIM_FILE}"></script><div id="root">`)
    expect(html).toContain('<script type="module" crossorigin src="./assets/main-abc.js"></script>')
  })

  it('writes the shim byte for byte, and it defines process.nextTick', async () => {
    await transformHtml(builtIndex(), { dirs })
    const served = await readFile(join(dirs.static, SHIM_FILE), 'utf8')
    expect(served.trim()).toBe(SHIM)
    const sandbox: { process?: { nextTick?: unknown }, queueMicrotask: (fn: () => void) => void, globalThis?: unknown } = { queueMicrotask }
    sandbox.globalThis = sandbox
    vm.runInNewContext(served, sandbox)
    expect(typeof sandbox.process?.nextTick).toBe('function')
  })

  it('is idempotent: a document already rewritten comes back unchanged', async () => {
    const once = await transformHtml(builtIndex(), { dirs })
    expect(await transformHtml(once, { dirs })).toBe(once)
  })

  it('throws, naming the cause, when the document no longer carries the shim', async () => {
    await expect(transformHtml('<!DOCTYPE html><html><head></head><body></body></html>', { dirs })).rejects.toThrow(/no inline process\.nextTick script/)
  })
})

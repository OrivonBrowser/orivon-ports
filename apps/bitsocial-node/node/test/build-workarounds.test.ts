// The build's workarounds against the pkc-js and uuid files the build really reads: each one must still find its text, and
// each one must fail loudly when the text is gone, so a new pin cannot ship half a fix.
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bundleFiles, writeBundleManifest } from '../../build/bundle-manifest.mjs'
import { debugLog } from '../../build/gap-debug-log.mjs'
import { dnsResultOrder } from '../../build/gap-dns.mjs'
import { startLock } from '../../build/gap-lock.mjs'
import { registryResolver } from '../../build/gap-registry.mjs'
import { builtinStubs, stubbedBuiltins } from '../../build/gap-stubs.mjs'
import { uuidRandomValues } from '../../build/gap-uuid.mjs'
import { addNodeComponent, NODE_COMPONENT } from '../../build/node-component.mjs'
import { replaceOnce, replaceText, requireApplied } from '../../build/text-patch.mjs'

const NODE_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules')
const CHUNKS = join(NODE_MODULES, '@pkcprotocol', 'pkc-js', 'dist', 'bundled', 'chunks')
const chunk = async (): Promise<{ path: string, text: string }> => {
  const name = (await readdir(CHUNKS)).find((one) => /^rpc-local-community-[\w-]+\.js$/.test(one)) ?? ''
  return { path: join(CHUNKS, name), text: await readFile(join(CHUNKS, name), 'utf8') }
}

describe('the pkc-js patches', () => {
  it('replaceText throws naming the text when it is not there', () => {
    expect(() => replaceText('missing text', 'x')('something else', '/a.js')).toThrow(/text not found in \/a\.js: missing text/)
    expect(replaceText('a', 'b')('cat', '/a.js')).toBe('cbt')
  })

  it('replaceOnce throws when the text is missing or appears more than once, and replaces the one place', () => {
    expect(() => replaceOnce('missing text', 'x')('something else', '/a.js')).toThrow(/text not found in \/a\.js: missing text/)
    expect(() => replaceOnce('a', 'b')('cat and bat', '/a.js')).toThrow(/text found more than once in \/a\.js: a/)
    expect(replaceOnce('c', 'b')('cat', '/a.js')).toBe('bat')
    expect(replaceOnce('$&', '$1')('x $& y', '/a.js')).toBe('x $1 y')
  })

  it('requireApplied names every patch that no file matched, and passes when each did', () => {
    const patches = [{ name: 'one', file: /a$/, apply: (text: string) => text }, { name: 'two', file: /b$/, apply: (text: string) => text }]
    expect(() => requireApplied(patches, new Set(['one']))).toThrow(/no file matched the patch "two"/)
    expect(() => requireApplied(patches, new Set())).toThrow(/patches "one", "two"/)
    expect(() => requireApplied(patches, new Set(['one', 'two']))).not.toThrow()
  })

  it('the dns patch finds its call in the installed chunk and wraps it', async () => {
    const { path, text } = await chunk()
    expect(dnsResultOrder.file.test(path)).toBe(true)
    const patched = dnsResultOrder.apply(text, path)
    expect(patched).not.toContain('\ndns.setDefaultResultOrder("ipv4first");')
    expect(patched).toContain('try { dns.setDefaultResultOrder("ipv4first"); }')
    expect(() => dnsResultOrder.apply('nothing here', path)).toThrow()
  })

  it('the lock patch replaces the library\'s region with the in-process lock and nothing around it', async () => {
    const { path, text } = await chunk()
    const patched = startLock.apply(text, path)
    expect(patched).toContain('import bitsocialProcessLock from "orivon-process-lock";')
    expect(patched).toContain('module.exports = bitsocialProcessLock;')
    expect(patched).not.toContain('async function lock(file, options) {\n\t\tconst release = await (0, adapter_1.toPromise)')
    expect(patched).toContain('//#region dist/node/runtime/node/community/start-lock.js')
    expect(patched.length).toBeLessThan(text.length)
    expect(() => startLock.apply('//#region elsewhere\n', path)).toThrow(/region is not in the chunk/)
  })

  it('the debug patch finds the line pkc-js\'s logger writes in the installed chunk and hands it to the Worker', async () => {
    const files = (await readdir(CHUNKS)).filter((one) => /^util-[\w-]+\.js$/.test(one))
    const holders = []
    for (const file of files) {
      const path = join(CHUNKS, file)
      const text = await readFile(path, 'utf8')
      if (text.includes('util.formatWithOptions(exports.inspectOpts, ...args)')) holders.push({ path, text })
    }
    expect(holders).toHaveLength(1)
    const { path, text } = holders[0]!
    expect(debugLog.file.test(path)).toBe(true)
    const patched = debugLog.apply(text, path)
    expect(patched).not.toContain('util.formatWithOptions(exports.inspectOpts')
    expect(patched).toContain('globalThis.__bitsocialPkcLog')
    expect(() => debugLog.apply('//#region node_modules/debug/src/node.js\nlog moved', path)).toThrow(/text not found/)
    expect(debugLog.apply('a util chunk with no debug in it', path)).toBe('a util chunk with no debug in it')
  })

  it('the uuid patch finds the pool fill in the uuid rpc-websockets uses', async () => {
    const file = join(NODE_MODULES, 'rpc-websockets', 'node_modules', 'uuid', 'dist', 'esm', 'rng.js')
    const patched = uuidRandomValues.apply(await readFile(file, 'utf8'), file)
    expect(patched).toContain('globalThis.crypto.getRandomValues(rnds8Pool);')
    expect(uuidRandomValues.file.test(file)).toBe(true)
  })
})

describe('the builtin stubs', () => {
  it('stub the four builtins the shim lacks, and nothing else', () => {
    expect(stubbedBuiltins.sort()).toEqual(['cluster', 'dns/promises', 'stream/web', 'v8'])
    expect(typeof builtinStubs.setup).toBe('function')
  })
})

describe('the registry resolver', () => {
  it('refuses an Orivon checkout that has no builtin registry, saying which file it looked for', () => {
    expect(() => registryResolver('/nonexistent/orivon')).toThrow(/cjs-builtins\.ts does not exist/)
  })
})

describe('the node component pin', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bitsocial-component-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('needs a directory when the pin names no CID, and says so', async () => {
    await expect(addNodeComponent(join(dir, 'out'), {}, { cid: null })).rejects.toThrow(/names no CID.*BITSOCIAL_IPFS_NODE_DIR/)
  })

  it('names the file that is missing', async () => {
    await expect(addNodeComponent(join(dir, 'out'), { BITSOCIAL_IPFS_NODE_DIR: dir })).rejects.toThrow(/ipfs-node\.js is not in/)
  })

  it('refuses a file whose bytes are not the pinned ones, whoever made them', async () => {
    for (const file of NODE_COMPONENT.files) await writeFile(join(dir, file.name), 'not the component')
    await expect(addNodeComponent(join(dir, 'out'), { BITSOCIAL_IPFS_NODE_DIR: dir })).rejects.toThrow(/is not the pinned ipfs-node\.js/)
  })

  it('pins every file of the component by size and sha256, and lists no flag the Worker would pass blindly', () => {
    for (const file of NODE_COMPONENT.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(NODE_COMPONENT.flags.every((flag) => /^--[a-z-]+$/.test(flag))).toBe(true)
  })
})

describe('the bundle manifest', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bitsocial-bundle-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('lists the Worker, its engine, the client, the dashboard module and everything under bin/, each with its sha256, and not the page', async () => {
    await mkdir(join(dir, 'node'), { recursive: true })
    await mkdir(join(dir, 'bin', 'ipfs-node.p2'), { recursive: true })
    await writeFile(join(dir, 'node', 'server.mjs'), 'server')
    await writeFile(join(dir, 'node', 'sqlite3.wasm'), 'wasm')
    await writeFile(join(dir, 'node-client.js'), 'client')
    await writeFile(join(dir, 'node-dashboard.js'), 'dashboard')
    await writeFile(join(dir, 'index.html'), 'page')
    await writeFile(join(dir, 'bin', 'LICENSE-MIT'), 'mit')
    await writeFile(join(dir, 'bin', 'ipfs-node.p2', 'ipfs-node.js'), 'node')
    const files = await bundleFiles(dir)
    expect(files.map((file) => file.path)).toEqual(['node/server.mjs', 'node/sqlite3.wasm', 'node-client.js', 'node-dashboard.js', 'bin/LICENSE-MIT', 'bin/ipfs-node.p2/ipfs-node.js'])
    expect(files[0]).toEqual({ path: 'node/server.mjs', bytes: 6, sha256: createHash('sha256').update('server').digest('hex') })
    const manifest = await writeBundleManifest(dir, { pkcJs: '0.0.132' })
    expect(JSON.parse(await readFile(join(dir, 'bundle.json'), 'utf8'))).toEqual(manifest)
  })
})

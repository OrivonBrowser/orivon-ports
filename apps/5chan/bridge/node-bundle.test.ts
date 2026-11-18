// What build/fetch-node-bundle.mjs does with the node bundle: copies exactly the pinned files, refuses any that is missing or
// differs, writes a pin from a bundle's own list, and agrees with the node component's pin in apps/bitsocial-node.
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bundleDirectory, pinFor, placeNodeBundle, readPinned } from '../build/fetch-node-bundle.mjs'
import pin from '../build/node-bundle-pin.mjs'
import componentPin from '../../bitsocial-node/build/node-component-pin.mjs'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const FILES: Record<string, string> = { 'node/server.mjs': 'server', 'node/sqlite3.wasm': 'wasm', 'node-client.js': 'client', 'node-dashboard.js': 'dashboard', 'bin/ipfs-node.p2/ipfs-node.js': 'component', 'bin/LICENSE-MIT': 'licence' }
const wanted = { pkcJs: '0.0.1', files: Object.entries(FILES).map(([path, text]) => ({ path, bytes: text.length, sha256: sha(text) })) }

let root: string
let bundle: string
let out: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fivechan-node-bundle-'))
  bundle = join(root, 'bundle')
  out = join(root, 'out')
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(join(bundle, ...path.split('/').slice(0, -1)), { recursive: true })
    await writeFile(join(bundle, ...path.split('/')), text)
  }
  await writeFile(join(bundle, 'index.html'), 'the node app\'s own page: not part of the pin')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const listing = async (dir: string): Promise<string[]> => (await readdir(dir, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1).split('\\').join('/')).sort()

describe('placeNodeBundle', () => {
  it('copies each pinned file to the same path under the destination, and nothing else the bundle holds', async () => {
    const placed = await placeNodeBundle(out, bundle, wanted)
    expect([...placed].sort()).toEqual(Object.keys(FILES).sort())
    expect(await listing(out)).toEqual(Object.keys(FILES).sort())
    expect(await readFile(join(out, 'node', 'server.mjs'), 'utf8')).toBe('server')
  })

  it('refuses a file that differs from its pin, by content as well as by size, and writes nothing', async () => {
    await writeFile(join(bundle, 'node-client.js'), 'clienT')
    await expect(placeNodeBundle(out, bundle, wanted)).rejects.toThrow(/node-client\.js .* is not the node this build pins/)
    await writeFile(join(bundle, 'node-client.js'), 'a longer client')
    await expect(placeNodeBundle(out, bundle, wanted)).rejects.toThrow(/is not the node this build pins/)
    await expect(readdir(out)).rejects.toThrow()
  })

  it('refuses a file that is missing, and says how to make the bundle', async () => {
    await rm(join(bundle, 'node', 'sqlite3.wasm'))
    await expect(placeNodeBundle(out, bundle, wanted)).rejects.toThrow(/has no node\/sqlite3\.wasm: build apps\/bitsocial-node .* BITSOCIAL_NODE_BUNDLE_DIR/)
  })

  it('names the way to move the pin when the node was rebuilt on purpose', async () => {
    await writeFile(join(bundle, 'node', 'server.mjs'), 'another worker')
    await expect(readPinned(bundle, wanted)).rejects.toThrow(/fetch-node-bundle\.mjs --pin/)
  })
})

describe('bundleDirectory', () => {
  it('is the directory BITSOCIAL_NODE_BUNDLE_DIR names, else the node app\'s own build output beside this app\'s', () => {
    expect(bundleDirectory({ BITSOCIAL_NODE_BUNDLE_DIR: '/somewhere/else' })).toBe('/somewhere/else')
    expect(bundleDirectory({ BITSOCIAL_NODE_BUNDLE_DIR: '' }).split('\\').join('/')).toMatch(/\/out\/bitsocial-node\/static$/)
    expect(bundleDirectory({}).split('\\').join('/')).toMatch(/\/out\/bitsocial-node\/static$/)
  })
})

describe('pinFor', () => {
  it('lists the files the bundle names, each measured again', async () => {
    await writeFile(join(bundle, 'bundle.json'), JSON.stringify({ pkcJs: '0.0.1', files: wanted.files }))
    expect(await pinFor(bundle)).toEqual(wanted)
  })

  it('refuses a bundle whose files are not what its own list says', async () => {
    await writeFile(join(bundle, 'bundle.json'), JSON.stringify({ pkcJs: '0.0.1', files: wanted.files }))
    await writeFile(join(bundle, 'node-client.js'), 'edited')
    await expect(pinFor(bundle)).rejects.toThrow(/not what its bundle\.json says/)
  })
})

describe('the pin this app ships', () => {
  it('names the Worker, its SQLite engine, the page module, the dashboard module and the component, each with a size and a sha256', () => {
    const paths = pin.files.map((file) => file.path)
    expect(paths).toEqual(expect.arrayContaining(['node/server.mjs', 'node/server.bundle.js.deflate', 'node/sqlite3.wasm', 'node-client.js', 'node-dashboard.js', 'bin/ipfs-node.p2/ipfs-node.js', 'bin/ipfs-node.p2/ipfs-node.core.wasm.deflate', 'bin/LICENSE-MIT', 'bin/LICENSE-APACHE']))
    expect(new Set(paths).size).toBe(paths.length)
    for (const file of pin.files) expect([file.path, file.bytes > 0, /^[0-9a-f]{64}$/.test(file.sha256)]).toEqual([file.path, true, true])
  })

  it('carries the IPFS node component the node app pins, byte for byte', () => {
    // The glue and the program ship in their packed forms, which the component's pin carries beside the plain files.
    for (const file of componentPin.files) {
      const shipped = componentPin.packed.find((one) => one.replaces === file.name) ?? file
      expect(pin.files.find((one) => one.path === `${file.under}/${shipped.name}`), file.name).toMatchObject({ bytes: shipped.bytes, sha256: shipped.sha256 })
    }
    expect(pin.files.filter((file) => file.path.startsWith('bin/'))).toHaveLength(componentPin.files.length)
  })
})

// Puts the Bitsocial node into the tree this build serves: the Worker (`node/`: its loader, its packed script and its SQLite engine), the
// page module that starts it (`node-client.js`) and the IPFS node component (`bin/`), copied from a build of
// apps/bitsocial-node and checked file by file against the size and sha256 in node-bundle-pin.mjs. A file that is
// missing or differs fails the build: a different node is a different release, and the pin moves with it.
//
//   node fetch-node-bundle.mjs <destination>      copy the pinned files into <destination>
//   node fetch-node-bundle.mjs --pin              rewrite the pin from the bundle's own bundle.json
//
// The bundle is the tree `orivon-port build bitsocial-node` writes, found at BITSOCIAL_NODE_BUNDLE_DIR, or else at that
// build's place beside this one. Nothing of the other app is read when the page runs: the copy is this app's own files.

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import pin from './node-bundle-pin.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PIN_FILE = join(here, 'node-bundle-pin.mjs')
const DEFAULT_BUNDLE = join(here, '..', '..', '..', 'out', 'bitsocial-node', 'static')

/** @param {string} root @param {string} path a `/`-separated path */
const under = (root, path) => join(root, ...path.split('/'))

/** @param {Uint8Array} bytes */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** The directory the bundle is in. @param {Record<string, string | undefined>} [env] */
export function bundleDirectory (env = process.env) {
  const named = env.BITSOCIAL_NODE_BUNDLE_DIR
  return named === undefined || named === '' ? DEFAULT_BUNDLE : named
}

/**
 * Reads each file of `wanted` from `directory` and compares it with its pin.
 * @param {string} directory @param {{ files: Array<{ path: string, bytes: number, sha256: string }> }} wanted
 * @returns {Promise<Array<{ path: string, data: Buffer }>>} every file, or throws naming the first that is missing or differs
 */
export async function readPinned (directory, wanted = pin) {
  const found = []
  for (const file of wanted.files) {
    const data = await readFile(under(directory, file.path)).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error(`the node bundle in ${directory} has no ${file.path}: build apps/bitsocial-node (orivon-port build bitsocial-node) or set BITSOCIAL_NODE_BUNDLE_DIR to its output`)
      throw error
    })
    if (data.length !== file.bytes || sha256(data) !== file.sha256) {
      throw new Error(`${file.path} in ${directory} is not the node this build pins (${String(data.length)} bytes, sha256 ${sha256(data).slice(0, 12)}; wanted ${String(file.bytes)} bytes, ${file.sha256.slice(0, 12)}): rebuild apps/bitsocial-node from the pinned sources, or move the pin with \`node build/fetch-node-bundle.mjs --pin\``)
    }
    found.push({ path: file.path, data })
  }
  return found
}

/** Copies the pinned files into `destination`. @param {string} destination @param {string} [directory] */
export async function placeNodeBundle (destination, directory = bundleDirectory(), wanted = pin) {
  const files = await readPinned(directory, wanted)
  for (const { path, data } of files) {
    await mkdir(dirname(under(destination, path)), { recursive: true })
    await writeFile(under(destination, path), data)
  }
  return files.map((file) => file.path)
}

/** The pin for the bundle in `directory`: its own list, each file measured again. @param {string} directory */
export async function pinFor (directory) {
  const listed = JSON.parse(await readFile(join(directory, 'bundle.json'), 'utf8'))
  const files = []
  for (const file of listed.files) {
    const data = await readFile(under(directory, file.path))
    if (data.length !== file.bytes || sha256(data) !== file.sha256) throw new Error(`${file.path} in ${directory} is not what its bundle.json says: rebuild it`)
    files.push({ path: file.path, bytes: data.length, sha256: sha256(data) })
  }
  return { pkcJs: String(listed.pkcJs), files }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [first] = process.argv.slice(2)
  if (first === '--pin') {
    const next = await pinFor(bundleDirectory())
    await writeFile(PIN_FILE, `// Written by fetch-node-bundle.mjs --pin from a build of apps/bitsocial-node: pkc-js's version and each file of the node's\n// bundle with its size and sha256.\nexport default ${JSON.stringify(next, null, 2)}\n`)
    console.log(`[5chan] pinned ${String(next.files.length)} node files (pkc-js ${next.pkcJs}) from ${bundleDirectory()}`)
  } else if (first === undefined) {
    console.error('usage: node fetch-node-bundle.mjs <destination> | --pin')
    process.exit(2)
  } else {
    const placed = await placeNodeBundle(first)
    console.log(`[5chan] the node bundle from ${bundleDirectory()}: ${String(placed.length)} files, each checked against the pin`)
  }
}

// Packing the node's two big files for the network: the Worker's bundle and the component's program are shipped as raw
// deflate streams, and the code that reads them unpacks them as they arrive (`DecompressionStream('deflate-raw')`, which
// a Chromium Worker has). What is read over IPFS is a quarter of the bytes; a build that wants the plain files sets
// `BITSOCIAL_NODE_COMPRESS=0`.
//
// The files are the app's own format, not a content encoding: the app fetches the bytes and unpacks them itself, so no host
// has to send a `Content-Encoding` header for them, and a raw deflate stream (no gzip header, no magic number) is not
// something the host-agnostic check (src/portable.ts) takes for a file that needs one.
//
// The deflate is made by fflate, not by node:zlib: Node's zlib is Chromium's fork, which picks a hash by the builder's CPU,
// so the same bytes would pack differently on two machines and `orivon-port verify` could not say MATCH between them.

import { copyFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const recipe = dirname(dirname(fileURLToPath(import.meta.url)))
const { deflateSync } = createRequire(join(recipe, 'node', 'package.json'))('fflate')

/** The packed bundle, beside `node/server.mjs`. */
export const SERVER_PACKED = 'server.bundle.js.deflate'
/** The file the glue of the node's program reads, in place of `ipfs-node.core.wasm`. */
export const PROGRAM_PACKED = 'ipfs-node.core.wasm.deflate'

/** The raw deflate stream level 9 makes of `bytes`, the same on every machine. @param {Uint8Array} bytes @returns {Buffer} */
export function deflateBytes (bytes) {
  return Buffer.from(deflateSync(bytes, { level: 9, mem: 12 }))
}

/**
 * Whether a switch is on: every `BITSOCIAL_NODE_*` switch is on unless it is `0`.
 * @param {string} name @param {Record<string, string | undefined>} [env]
 */
export function switchedOn (name, env = process.env) {
  return env[name] !== '0'
}

/**
 * Writes the Worker's files into `nodeDir`: the packed bundle and the small `server.mjs` that runs it (`server-loader.mjs`).
 * @param {string} nodeDir the built tree's `node/` @param {Uint8Array} bundle the bundle's text
 */
export async function writePackedServer (nodeDir, bundle) {
  await writeFile(join(nodeDir, SERVER_PACKED), deflateBytes(bundle))
  await copyFile(join(recipe, 'build', 'server-loader.mjs'), join(nodeDir, 'server.mjs'))
}

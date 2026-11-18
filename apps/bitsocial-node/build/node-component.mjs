// Orivon's IPFS node as this app ships it: the component the Worker spawns as `/bin/ipfs-node`, pinned by the
// size and sha256 of each file in `node-component-pin.mjs`, and published on IPFS as one folder named by the pin's `cid`.
// The build fetches each file of that folder from a public gateway and checks it against its pin, so a gateway can serve
// the wrong bytes and the build still stops. `BITSOCIAL_IPFS_NODE_DIR` names a local directory that holds the files (flat, or
// under `ipfs-node.p2/` or `stage/`) and is read in place of the network: a network whose resolver hijacks the gateways,
// or a trial build. Either way a file that does not match its pin fails the build, whoever made it.
//
// `flags` are the command-line options this component accepts beyond the ones every build has, and the Worker passes only
// those. Moving to another build is one command, which rewrites the pin from a build and the CID it is published under
// (`node build/node-component.mjs <directory> --flags a,b --features x,y --cid <cid>`).
//
// A packed copy (the default; `BITSOCIAL_NODE_COMPRESS=0` for the plain files) carries the node's program, `ipfs-node.core.wasm`,
// deflated, and its glue (`ipfs-node.js`, jco's output) reads that file in place of the plain one: the glue is the pinned one with a
// single line changed, `packGlue`. Orivon's host hands the glue a loader for the program's parts, and the glue does not use it
// for the big one: the host's loader reads a part whole before it compiles it, and this one is compiled as it is unpacked.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pinned from './node-component-pin.mjs'
import { deflateBytes, PROGRAM_PACKED } from './pack.mjs'

/** The program's part the glue loads, and how: the one line of the glue `packGlue` replaces. */
const PROGRAM = 'ipfs-node.core.wasm'
/** The component's glue, jco's output, which loads the program. */
const GLUE = 'ipfs-node.js'
const PROGRAM_LOAD = `const module0 = getCoreModule('${PROGRAM}');`
/** Reads the packed program and compiles it as it is unpacked, so compiling goes on while the rest arrives. */
const PROGRAM_LOAD_PACKED = `const module0 = fetch(new URL('./${PROGRAM_PACKED}', import.meta.url)).then((answer) => {
  if (!answer.ok || answer.body === null) throw new Error('the node program (${PROGRAM_PACKED}) is not served: ' + answer.status);
  return WebAssembly.compileStreaming(new Response(answer.body.pipeThrough(new DecompressionStream('deflate-raw')), { headers: { 'content-type': 'application/wasm' } }));
});`

/**
 * The glue with its load of the program's part changed to read the packed file. The line must be there exactly once: a
 * glue that changed shape fails the build instead of shipping one that cannot find its program.
 * @param {string} glue
 */
export function packGlue (glue) {
  const first = glue.indexOf(PROGRAM_LOAD)
  if (first === -1 || glue.indexOf(PROGRAM_LOAD, first + 1) !== -1) throw new Error(`the node's glue does not load its program once, as \`${PROGRAM_LOAD}\``)
  return glue.slice(0, first) + PROGRAM_LOAD_PACKED + glue.slice(first + PROGRAM_LOAD.length)
}

/**
 * The file a packed tree ships in place of the component's `name`: the glue with its one line changed, or the program deflated; nothing for the other files.
 * @param {string} name @param {Buffer} bytes @returns {{ name: string, bytes: Buffer } | undefined}
 */
export function packedForm (name, bytes) {
  if (name === PROGRAM) return { name: PROGRAM_PACKED, bytes: deflateBytes(bytes) }
  if (name === GLUE) return { name, bytes: Buffer.from(packGlue(bytes.toString('utf8'))) }
  return undefined
}

/** The gateways a file is fetched from, in turn: one that fails, or answers other bytes than the pin's, hands the file to the next. */
export const GATEWAYS = Object.freeze(['https://ipfs.orbitor.dev', 'https://ipfs.filebase.io', 'https://trustless-gateway.link'])
/** How long one gateway has to send one file: the program is 20 MB. */
const FETCH_TIMEOUT_MS = 600_000

export const NODE_COMPONENT = Object.freeze({
  /** The folder's CID, which holds every file of the component (`ipfs-node.p2/` and the two licences at its root), or null for a pin written from a local build that was never published. */
  cid: pinned.cid ?? null,
  features: pinned.features,
  flags: pinned.flags,
  files: pinned.files,
  /** The packed forms of the files that have one (`packedForm`), each with the file it replaces: what a packed tree holds in their place, by size and sha256. */
  packed: pinned.packed
})

/** @param {string} directory the folder the files are in @param {string} name */
function locate (directory, name) {
  const found = [join(directory, name), join(directory, 'ipfs-node.p2', name), join(directory, 'stage', name)].find((path) => existsSync(path))
  if (found === undefined) throw new Error(`${name} is not in ${directory}, nor in its ipfs-node.p2/ or stage/`)
  return found
}

/**
 * What differs between `bytes` and the pinned `file`, or undefined when they are it.
 * @param {Uint8Array} bytes @param {{ bytes: number, sha256: string }} file
 */
function mismatch (bytes, file) {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return bytes.length === file.bytes && sha256 === file.sha256 ? undefined : `${String(bytes.length)} bytes, sha256 ${sha256}; the pin is ${String(file.bytes)} bytes, ${file.sha256}`
}

/** @param {unknown} error the failure of one gateway, in a line: its message and, for a network error, what the network said */
function why (error) {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause instanceof Error ? ` (${(/** @type {{ code?: string }} */ (error.cause)).code ?? error.cause.message})` : ''
  return error.message + cause
}

/**
 * One file of the published folder, from the first gateway that sends the pinned bytes. A plain GET is a complete check: the pin holds the file's sha256.
 * @param {typeof NODE_COMPONENT.files[number]} file
 * @param {{ cid: string, gateways: readonly string[], fetch: typeof globalThis.fetch }} source
 * @returns {Promise<Buffer>}
 */
async function fetchPinned (file, { cid, gateways, fetch: get }) {
  const folder = file.under.replace(/^bin\/?/, '')
  const path = folder === '' ? file.name : `${folder}/${file.name}`
  /** @type {string[]} */
  const failures = []
  for (const gateway of gateways) {
    try {
      const answer = await get(`${gateway}/ipfs/${cid}/${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!answer.ok) throw new Error(`answered ${String(answer.status)}`)
      const bytes = Buffer.from(await answer.arrayBuffer())
      const wrong = mismatch(bytes, file)
      if (wrong !== undefined) throw new Error(`sent other bytes than the pinned ${file.name}: ${wrong}`)
      return bytes
    } catch (error) {
      failures.push(`${gateway}: ${why(error)}`)
    }
  }
  throw new Error(`${path} of the IPFS node component ${cid} could not be fetched:\n  ${failures.join('\n  ')}\nSet BITSOCIAL_IPFS_NODE_DIR to a directory that holds the component's files to build without the network.`)
}

/**
 * Copies the component into `out`, each file checked against its pin and read from `BITSOCIAL_IPFS_NODE_DIR` when that is set, and fetched from the gateways by the pin's CID when it is not; with `compress` the program is written packed and the glue reads it so, each checked against its packed form in the pin.
 * @param {string} out the built tree @param {Record<string, string | undefined>} [env]
 * @param {{ compress?: boolean, files?: typeof NODE_COMPONENT.files, packed?: typeof NODE_COMPONENT.packed, cid?: string | null, gateways?: readonly string[], fetch?: typeof globalThis.fetch }} [options] `files`, `packed` and `cid` are the pin's, `gateways` the list above and `fetch` the network's, or others for a test
 */
export async function addNodeComponent (out, env = process.env, { compress = false, files = NODE_COMPONENT.files, packed = NODE_COMPONENT.packed, cid = NODE_COMPONENT.cid, gateways = GATEWAYS, fetch = globalThis.fetch } = {}) {
  const directory = env['BITSOCIAL_IPFS_NODE_DIR']
  const local = directory !== undefined && directory !== ''
  if (!local && cid === null) throw new Error('node-component-pin.mjs names no CID to fetch the IPFS node component by: set BITSOCIAL_IPFS_NODE_DIR to a directory that holds it (ipfs-node.js, its .wasm files and the two licences)')
  for (const file of files) {
    let bytes
    if (local) {
      const from = locate(directory, file.name)
      bytes = await readFile(from)
      const wrong = mismatch(bytes, file)
      if (wrong !== undefined) throw new Error(`${from} is not the pinned ${file.name}: ${wrong}`)
    } else {
      bytes = await fetchPinned(file, { cid: /** @type {string} */ (cid), gateways, fetch })
    }
    const form = compress ? packedForm(file.name, bytes) : undefined
    if (form !== undefined) {
      const want = packed.find((one) => one.replaces === file.name)
      if (want === undefined) throw new Error(`node-component-pin.mjs pins no packed form of ${file.name}: pin the component again (node build/node-component.mjs <directory> --flags a,b --features x,y --cid <cid>)`)
      const packedSha = createHash('sha256').update(form.bytes).digest('hex')
      if (form.name !== want.name || form.bytes.length !== want.bytes || packedSha !== want.sha256) {
        throw new Error(`the packed ${form.name} is not the pinned one: ${String(form.bytes.length)} bytes, sha256 ${packedSha}; the pin is ${String(want.bytes)} bytes, ${want.sha256} (a changed packer or glue line: pin the component again on purpose)`)
      }
    }
    const to = join(out, file.under, form?.name ?? file.name)
    await mkdir(dirname(to), { recursive: true })
    await writeFile(to, form?.bytes ?? bytes)
  }
}

/**
 * Writes `node-component-pin.mjs` for the component in `directory`: its files as found and the packed form of each that has one, with `flags` and `features`
 * the node reports and the `cid` of the folder it is published under (`node node-component.mjs <directory> --flags a,b --features x,y --cid <cid>`;
 * without one the pin names no CID, and a build reads the files from `BITSOCIAL_IPFS_NODE_DIR`). The pin is a claim about a build, so
 * it is written only on purpose and read back by every build.
 * @param {string} directory @param {string[]} flags @param {string[]} features
 * @param {{ target?: string, files?: typeof NODE_COMPONENT.files, cid?: string | null }} [options] another file to write, another list of files, and the folder's CID, for a test or a build
 */
export async function writePin (directory, flags, features, { target = fileURLToPath(new URL('./node-component-pin.mjs', import.meta.url)), files: listed = NODE_COMPONENT.files, cid = null } = {}) {
  const files = []
  const packed = []
  for (const file of listed) {
    const bytes = await readFile(locate(directory, file.name))
    files.push({ ...file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    const form = packedForm(file.name, bytes)
    if (form !== undefined) packed.push({ name: form.name, replaces: file.name, bytes: form.bytes.length, sha256: createHash('sha256').update(form.bytes).digest('hex'), under: file.under })
  }
  await writeFile(target, `// Written by node-component.mjs from a build of the node component: the CID of the folder it is published under, its flags, its features, each file's size and sha256, and the size and sha256 of the packed form of the files that have one.\nexport default ${JSON.stringify({ cid, features, flags, files, packed }, null, 2)}\n`)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [directory] = process.argv.slice(2)
  const option = (/** @type {string} */ name) => (process.argv.includes(name) ? String(process.argv[process.argv.indexOf(name) + 1]) : undefined)
  const list = (/** @type {string} */ name) => (option(name) ?? '').split(',').filter(Boolean)
  if (directory === undefined || directory.startsWith('--')) throw new Error('usage: node node-component.mjs <component directory> --flags a,b --features x,y --cid <the folder\'s CID>')
  await writePin(directory, list('--flags'), list('--features'), { cid: option('--cid') ?? null })
}

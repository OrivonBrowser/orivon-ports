// The Bitsocial Node's Worker under plain Node: `worker/run.js` with the native build of the IPFS node in place of the
// component, and the real file system and sockets. Forked by `go-no-go.js` (or run by hand for a measurement); it takes the
// Worker's configuration from `BITSOCIAL_NODE`, the node binary from `IPFS_NODE_BIN` and the component's flags from
// `IPFS_NODE_FLAGS` (a JSON list), and talks to its parent as the Worker talks to a page. `BOARD_MANAGER_BUNDLE` names the 5chan board
// manager as one module (`bundleBoardManager` in `build/board-manager.mjs` makes it); with it the Worker runs the board managers.
// The anti-spam challenge packages are registered as in the Worker, with the captcha on the pure-JavaScript canvas. `ETH_RPC_URLS` (a JSON list)
// names the Ethereum providers the name resolvers ask in place of the desktop clients' six.

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { appendFileSync } from 'node:fs'
import { mkdir, readFile, rmdir, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { challenges as pkcChallenges } from '@pkcprotocol/pkc-js'
import PKCRpc from '@pkcprotocol/pkc-js/rpc'
import { aliasSkiaCanvas } from './pure-canvas-hook.js'

aliasSkiaCanvas()
const { NODE_PROGRAM, startWorker } = await import('../worker/run.js')

const bin = process.env['IPFS_NODE_BIN']
if (bin === undefined || bin === '') throw new Error('IPFS_NODE_BIN names the native node binary')
const flags = JSON.parse(process.env['IPFS_NODE_FLAGS'] ?? '["--publish","--key-secret","--max-ipns-keys","--http-router","--relay"]')

const bundle = process.env['BOARD_MANAGER_BUNDLE']
const boardManager = bundle === undefined || bundle === '' ? undefined : await import(pathToFileURL(bundle).href)

for (const event of /** @type {const} */ (['uncaughtException', 'unhandledRejection'])) {
  process.on(event, (error) => { console.log(`[host] ${event}: ${error instanceof Error ? `${error.message}\n${String(error.stack).slice(0, 1200)}` : String(error)}`) })
}

await startWorker({
  env: process.env,
  send: (message) => { process.send?.(message) },
  onMessage: (handler) => { process.on('message', handler) },
  exit: (code) => { process.exit(code) },
  spawn: /** @type {any} */ ((/** @type {string} */ program, /** @type {string[]} */ args) => {
    const child = spawn(program === NODE_PROGRAM ? bin : program, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    // `NODE_LOG_FILE` keeps every line the node writes, which the Worker's own log does not (a measurement counts them).
    const file = process.env['NODE_LOG_FILE']
    if (file !== undefined) for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk) => { appendFileSync(file, chunk) })
    return child
  }),
  fetch: globalThis.fetch.bind(globalThis),
  http,
  PKCRpc: /** @type {any} */ (PKCRpc),
  ...(boardManager === undefined ? {} : { boardManager }),
  fs,
  challenges: { registry: pkcChallenges },
  // A run that must read the chain from a local fork names it here; the Worker never takes this from its configuration.
  ...(process.env['ETH_RPC_URLS'] === undefined ? {} : { ethRpcUrls: JSON.parse(process.env['ETH_RPC_URLS']) }),
  scope: globalThis,
  mkdir: (path) => mkdir(path, { recursive: true }),
  removeDir: (path) => rmdir(path).then(() => true, (error) => (error?.code === 'ENOENT' ? false : Promise.reject(error))),
  readText: (path) => readFile(path, 'utf8').catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error))),
  writeText: (path, text) => writeFile(path, text, { mode: 0o600 }),
  randomHex: (bytes) => randomBytes(bytes).toString('hex'),
  nodeFlags: flags
}).catch((error) => {
  console.log(`[host] the Worker failed: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})

// The Bitsocial Node's Worker, the file the page forks. The three imports ahead of the rest open the SQLite engine, register
// the builtins pkc-js needs at run time and set the log namespaces, and they must come first: pkc-js reads all three when it loads.

import 'orivon-node-shim/sqlite-ready'
import './workarounds/register-builtins.js'
import './enable-diagnostics.js'
import { spawn } from 'child_process'
import * as fs from 'fs'
import { mkdir, readFile, rmdir, writeFile } from 'fs/promises'
import http from 'http'
import { challenges as pkcChallenges } from '@pkcprotocol/pkc-js'
import PKCRpc from '@pkcprotocol/pkc-js/rpc'
import * as boardManager from './board-manager-entry.js'
import { startWorker } from './run.js'
import { supportBase64Url } from './workarounds/base64url.js'

/** The component's extra command-line flags, set by the build from `build/node-component.mjs`. */
const nodeFlags = typeof BITSOCIAL_NODE_FLAGS === 'undefined' ? [] : BITSOCIAL_NODE_FLAGS

// The spam-blocker challenge writes its challenge address with the 'base64url' encoding, which the shim's Buffer lacks.
supportBase64Url(globalThis.Buffer)

/** @param {unknown} error */
const textOf = (error) => (error instanceof Error ? `${error.name}: ${error.message}\n${String(error.stack ?? '').slice(0, 1200)}` : String(error))

for (const event of /** @type {const} */ (['uncaughtException', 'unhandledRejection'])) {
  process.on(event, (error) => { console.log(`[bitsocial-node] ${event}: ${textOf(error)}`) })
}

startWorker({
  env: process.env,
  send: (message) => { try { process.send?.(message) } catch (error) { console.log(`[bitsocial-node] send failed: ${String(error)}`) } },
  onMessage: (handler) => { process.on('message', handler) },
  exit: (code) => { process.exit(code) },
  spawn,
  fetch: globalThis.fetch.bind(globalThis),
  // The node's API is called over `http`, one socket a request, unless BITSOCIAL_NODE_FETCH=fetch asks for the engine's own fetch (a measurement).
  nodeOverHttp: process.env['BITSOCIAL_NODE_FETCH'] !== 'fetch',
  orivon: globalThis.orivon,
  http,
  PKCRpc,
  boardManager,
  challenges: { registry: pkcChallenges },
  fs,
  scope: globalThis,
  mkdir: (path) => mkdir(path, { recursive: true }),
  removeDir: (path) => rmdir(path).then(() => true, (error) => (error?.code === 'ENOENT' ? false : Promise.reject(error))),
  readText: (path) => readFile(path, 'utf8').catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error))),
  writeText: (path, text) => writeFile(path, text, { mode: 0o600 }),
  randomHex: (bytes) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, '0')).join(''),
  nodeFlags
}).catch((error) => {
  console.log(`[bitsocial-node] the Worker failed: ${textOf(error)}`)
  try { process.send?.({ type: 'failed', stage: 'worker', message: error instanceof Error ? error.message : String(error), code: null }) } catch { /* the page is gone */ }
  process.exit(1)
})

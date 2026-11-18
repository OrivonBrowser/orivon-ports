#!/usr/bin/env node
// Runs the node's wasm component under wasmtime with the same command line as the native binary, so `go-no-go.js` and
// `host.js` can take it as IPFS_NODE_BIN. It separates a fault of the component from a fault of Orivon's own host.
//   WASMTIME=<wasmtime> WASM=<ipfs-node.wasm> [WASM_DIRS="/tmp /dev/shm"] IPFS_NODE_BIN=<this file> node go-no-go.js ...

import { spawn } from 'node:child_process'

const wasmtime = process.env['WASMTIME']
const wasm = process.env['WASM']
if (wasmtime === undefined || wasm === undefined) throw new Error('set WASMTIME to a wasmtime binary and WASM to the node component (ipfs-node.wasm)')
const dirs = (process.env['WASM_DIRS'] ?? '/tmp').split(/\s+/).filter(Boolean).flatMap((dir) => ['--dir', dir])
const child = spawn(wasmtime, ['run', '-S', 'inherit-network=y', '-S', 'allow-ip-name-lookup=y', '-S', 'tcp=y', '-S', 'udp=y', ...dirs, wasm, ...process.argv.slice(2)], { stdio: 'inherit' })
for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT'])) process.on(signal, () => { child.kill(signal) })
child.once('exit', (code, signal) => { process.exit(code ?? (signal === null ? 0 : 1)) })

// A local anvil forked from mainnet at one block, started per test file. Without anvil, or with no public node that
// can serve that block, the fork tests skip and say why.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'

/** After the registry's setup (its last block is 26357161), so the reserved names and the sale are live. */
export const FORK_BLOCK = 26357300

const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'

const R1 = '0xDD1DecE58Eb7a5CebF8c1e0834b7eD4096e7ED20'
const FIRST_REGISTRY_BLOCK = 26357113

/**
 * The first that serves what the tests read wins: state at FORK_BLOCK (a node that is not an archive stops serving it
 * within minutes) and log queries over old blocks (several free nodes refuse them or cap the range).
 */
const NODES = [
  ...(process.env['ORIVON_ID_FORK_RPC'] === undefined ? [] : [process.env['ORIVON_ID_FORK_RPC']]),
  'https://rpc.flashbots.net',
  'https://rpc.mevblocker.io'
]

export interface Fork {
  url: string
  nodeUrl: string
  stop: () => Promise<void>
}

async function freePort (): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => { typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no port')) })
    })
  })
}

async function rpc (url: string, method: string, params: unknown[], ms = 10_000): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(ms)
  })
  const body = await response.json() as { result?: unknown, error?: { message: string } }
  if (body.error !== undefined) throw new Error(body.error.message)
  return body.result
}

async function nodeServing (block: number): Promise<string | null> {
  for (const url of NODES) {
    try {
      const code = await rpc(url, 'eth_getCode', [DAI, '0x' + block.toString(16)])
      if (typeof code !== 'string' || !code.startsWith('0x6080')) continue
      const logs = await rpc(url, 'eth_getLogs', [{ address: R1, fromBlock: '0x' + FIRST_REGISTRY_BLOCK.toString(16), toBlock: '0x' + (FIRST_REGISTRY_BLOCK + 10).toString(16) }])
      if (Array.isArray(logs)) return url
    } catch {
      // Try the next node.
    }
  }
  return null
}

/** A fork at FORK_BLOCK, or the reason there is none. */
export async function startFork (): Promise<Fork | { skip: string }> {
  if (spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status !== 0) return { skip: 'anvil is not installed (Foundry)' }
  const nodeUrl = await nodeServing(FORK_BLOCK)
  if (nodeUrl === null) return { skip: `no public Ethereum node served block ${FORK_BLOCK}: offline, or none keeps old state` }
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const child: ChildProcess = spawn('anvil', [
    '--fork-url', nodeUrl, '--fork-block-number', String(FORK_BLOCK), '--host', '127.0.0.1', '--port', String(port),
    '--no-rate-limit', '--retries', '6', '--timeout', '60000', '--silent'
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let failure = ''
  child.stderr?.on('data', (chunk: Buffer) => { failure += chunk.toString() })
  let exited = false
  child.once('exit', () => { exited = true })
  const stop = async (): Promise<void> => {
    if (exited) return
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
  process.once('exit', () => { if (!exited) child.kill('SIGKILL') })
  for (let waited = 0; waited < 90_000 && !exited; waited += 250) {
    try {
      await rpc(url, 'eth_blockNumber', [], 2000)
      return { url, nodeUrl, stop }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  await stop()
  return { skip: `anvil did not start: ${failure.trim().slice(0, 300) || 'no output'}` }
}

/** Raw JSON-RPC to the fork, for what the Chain does not offer (impersonation, mining, storage). */
export const anvilRpc = rpc

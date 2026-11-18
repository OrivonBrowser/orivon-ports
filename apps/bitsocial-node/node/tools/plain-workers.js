// The pieces a run with several Workers under plain Node is made of: a free loopback port, one Worker (`host.js`) with its own files, ports and node,
// and a loopback kubo that plays a reader, a poster or a circuit relay. `seeding.js` (two Workers) and `drive-host.js` (the remote side of a shell drive) share them.

import { fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startKubo } from './kubo.js'
import { waitFor } from './scenario.js'

const here = dirname(fileURLToPath(import.meta.url))

export const freePort = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = /** @type {import('node:net').AddressInfo} */ (server.address()); server.close(() => { resolve(port) }) }) })
/** @param {unknown} error */
export const textOf = (error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))

/**
 * @param {{ dir: string, log: (line: string) => void, out?: import('node:stream').Writable, nodeBin: string, kuboBin: string }} run
 *   `dir` holds each Worker's files and logs, `out` keeps the Workers' own output, `nodeBin` is the node binary or `wasmtime-node.js`
 */
export function plainWorkers ({ dir, log, out, nodeBin, kuboBin }) {
  return {
    /**
     * One Worker under plain Node, with its own files, ports and node. `bootstrap` is the loopback peers its node dials at the start, `relay` the one it holds a place on.
     * @param {string} label @param {string[]} bootstrap @param {string} [relay] @param {string[]} [routers] loopback HTTP routers it asks for providers
     */
    async startWorker (label, bootstrap, relay, routers = []) {
      const [rpc, gateway, fakeKubo, nodeApi, p2p] = await Promise.all(Array.from({ length: 5 }, freePort))
      const authKey = randomBytes(16).toString('hex')
      const files = join(dir, `${label}-files`)
      await mkdir(files, { recursive: true })
      const config = { authKey, files, ports: { rpc, gateway, kubo: fakeKubo, nodeApi, p2p }, origins: [], trace: process.env['PLAIN_TRACE'] ?? 'warn', isolated: { bootstrap, ...(routers.length === 0 ? {} : { routers }) }, ...(relay === undefined ? {} : { relay }) }
      const host = fork(join(here, 'host.js'), [], { silent: true, detached: true, serialization: 'advanced', env: { ...process.env, BITSOCIAL_NODE: JSON.stringify(config), IPFS_NODE_BIN: nodeBin, NODE_LOG_FILE: join(dir, `${label}-node.log`), NODE_ENV: 'production' } })
      const messages = /** @type {Array<Record<string, any>>} */ ([])
      for (const stream of [host.stdout, host.stderr]) stream?.on('data', (chunk) => { for (const line of String(chunk).split('\n')) if (line.trim() !== '') out?.write(`  ${label}: ${line.slice(0, 2400)}\n`) })
      host.on('message', (/** @type {Record<string, any>} */ message) => { messages.push(message); if (message['type'] !== 'status') log(`${label} says ${JSON.stringify(message).slice(0, 240)}`) })
      const ready = await waitFor(() => messages.find((message) => message['type'] === 'ready' || message['type'] === 'failed'), 240_000, `${label} never said ready`)
      if (ready['type'] !== 'ready') throw new Error(`${label} failed: ${JSON.stringify(ready)}`)
      const peer = await waitFor(() => messages.filter((message) => message['type'] === 'status').map((message) => message['status']?.peer).find((one) => typeof one === 'string'), 60_000, `${label}'s node never reported its peer`)
      const address = `/ip4/127.0.0.1/tcp/${p2p}/p2p/${peer}`
      log(`${label} is ready: node ${peer} on ${address}`)
      /** One control call of the Worker's gateway socket, as a page makes it. @param {string} area @param {string} name @param {Record<string, unknown>} [body] */
      const call = async (area, name, body = {}) => {
        const answer = await fetch(`http://127.0.0.1:${gateway}/orivon/${area}/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${authKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        const value = await answer.json()
        if (!answer.ok) throw new Error(`${area}/${name}: ${answer.status} ${JSON.stringify(value)}`)
        return value
      }
      return {
        label, host, files, address, peer, rpcUrl: `ws://127.0.0.1:${rpc}/${authKey}`, call,
        /** One of the read-only calls a page makes (`/orivon/api/`). @param {string} name */
        async api (name) {
          const answer = await fetch(`http://127.0.0.1:${gateway}/orivon/api/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${authKey}` } })
          if (!answer.ok) throw new Error(`api/${name}: ${answer.status}`)
          return answer.json()
        },
        kill () { if (host.pid !== undefined) { try { process.kill(-host.pid, 'SIGKILL') } catch { /* gone */ } } },
        ended: () => waitFor(() => (host.exitCode !== null || host.signalCode !== null ? true : undefined), 60_000, `${label} did not end`)
      }
    },
    /** A loopback kubo on a repository of its own. @param {string} name @param {{ relayService?: boolean }} [options] */
    async startKubo (name, { relayService = false } = {}) {
      return startKubo({ bin: kuboBin, repo: join(dir, name), mode: 'loopback', swarmPort: /** @type {number} */ (await freePort()), gatewayPort: /** @type {number} */ (await freePort()), apiPort: /** @type {number} */ (await freePort()), relayService, logFile: join(dir, `${name}.log`), ...(relayService ? { logLevel: 'error,relay=debug' } : {}), log })
    }
  }
}

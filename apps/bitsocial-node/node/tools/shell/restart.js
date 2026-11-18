// A board that comes back after the app is closed and opened again, in the Orivon shell. The built app is served and
// opened, its page starts the Worker, and a pkc-js client creates and starts a community through the Worker's RPC. The
// tab then leaves the app's origin, which ends the Worker the way the shell ends it when an app's last page closes (no
// stop message), and comes back: a new Worker starts over the same files, and the run says whether pkc-js's RPC server
// started the community again by itself and how long that took. The Worker's own log, pkc-js's (`DRIVE_DEBUG`, a `debug`
// pattern added to the lines the Worker always writes about its RPC server's start) and the node's lines are kept in the result. Run it with
// `run.js` and `DRIVE_MODE=restart`.

import { mkdirSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import PKC from '@pkcprotocol/pkc-js'
import { sleep, waitFor } from '../scenario.js'
import { closeApp, openApp, ORIGIN, RESULTS, serveApp } from './harness.js'

const DEFAULT_DEBUG = 'pkc-js-rpc:pkc-ws-server*,pkc-js:local-community:start*'
const textOf = (/** @type {unknown} */ error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))

/** The page, with `debug` put on the node-client call it makes: more of pkc-js's log namespaces for the Worker to write. @param {string} pattern */
const withDebug = (pattern) => `(() => { const c = globalThis.BitsocialNodeClient; const start = c.startBitsocialNode; globalThis.BitsocialNodeClient = { ...c, startBitsocialNode: (options, deps) => start({ ...options, debug: ${JSON.stringify(pattern)} }, deps) } })()`

/** @param {number} port */
const answers = (port) => new Promise((resolve) => {
  const socket = connect(port, '127.0.0.1')
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('error', () => { resolve(false) })
})

/** Runs the restart once, writes the result under DRIVE_RESULTS and returns it. @param {{ debug?: string, backMs?: number }} [options] */
export async function runRestart ({ debug = process.env['DRIVE_DEBUG'] ?? DEFAULT_DEBUG, backMs = 240_000 } = {}) {
  mkdirSync(RESULTS, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const began = Date.now()
  const lines = /** @type {string[]} */ ([])
  const log = (/** @type {string} */ line) => { const text = `[${((Date.now() - began) / 1000).toFixed(1)}s] ${line}`; lines.push(text); console.log(text) }
  const result = /** @type {Record<string, any>} */ ({ when: stamp, mode: 'restart', ok: false, steps: {} })
  /** @type {Awaited<ReturnType<typeof openApp>> | undefined} */
  let shell
  /** @type {import('node:http').Server | undefined} */
  let server
  /** @type {any} */
  let pkc
  /** @type {any} */
  let pkc2
  try {
    server = await serveApp(debug === '' ? {} : { pageScript: withDebug(debug) })
    shell = await openApp({ log })
    const upFirst = await waitFor(async () => { const now = await shell?.snapshot(); if (now?.error != null) throw new Error(`the page could not start the node: ${now.error}`); return now?.snapshot?.running === true && typeof now.snapshot.peer === 'string' ? now : undefined }, 420_000, 'the first Worker never came up')
    result.steps.firstUpMs = Date.now() - began
    const rpcUrl = String(upFirst.rpcUrl).replace('ws://localhost:', 'ws://127.0.0.1:')
    const rpcPort = Number(new URL(rpcUrl).port)
    log(`the first Worker is up: node ${upFirst.snapshot.peer}, RPC ${rpcUrl.replace(/\/[^/]+$/, '/<key>')}`)

    pkc = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined })
    pkc.on('error', (/** @type {unknown} */ error) => { log(`client error: ${textOf(error)}`) })
    const community = await pkc.createCommunity({ title: 'restart board', description: 'a board that must come back' })
    community.on('error', (/** @type {unknown} */ error) => { log(`community error: ${textOf(error)}`) })
    const address = String(community.address)
    const startBegan = Date.now()
    for (let attempt = 1; ; attempt += 1) {
      try { await community.start(); break } catch (error) {
        if (!/not local|toJSONInternalRpcBeforeFirstUpdate/.test(textOf(error)) || attempt >= 5) throw error
        log(`start failed as an unlisted community (try ${attempt} of 5): ${textOf(error)}`)
        await sleep(2000)
      }
    }
    await waitFor(() => (community.updatedAt !== undefined && community.startedState === 'succeeded' ? true : undefined), 360_000, `the community never published (state ${String(community.startedState)})`)
    const firstUpdatedAt = /** @type {number} */ (community.updatedAt)
    result.steps.firstStart = { address, ms: Date.now() - startBegan, updatedAt: firstUpdatedAt }
    log(`community ${address} started in ${Date.now() - startBegan} ms, updatedAt ${firstUpdatedAt}`)
    await pkc.destroy().catch(() => {})
    pkc = undefined

    // The last page of the app leaves: the shell ends the Worker with no stop message.
    const { clickAddressBarRetrying } = await import(`${process.env['ORIVON_MVP_ROOT']}/test/support/e2e-helpers.js`)
    await clickAddressBarRetrying(shell.chrome, 'http://127.0.0.1:9/')
    const ended = await waitFor(async () => (await answers(rpcPort) ? undefined : true), 180_000, 'the Worker did not end after the page left').catch(() => false)
    result.steps.workerEndedMs = Date.now() - began
    result.steps.workerEnded = ended !== false
    log(`the Worker ${ended === false ? 'is still answering' : 'ended'} after the page left`)
    await sleep(3000)

    await clickAddressBarRetrying(shell.chrome, `${ORIGIN}/`)
    const secondBegan = Date.now()
    const upSecond = await waitFor(async () => { const now = await shell?.snapshot(); if (now?.error != null) throw new Error(`the page could not start the node: ${now.error}`); return now?.snapshot?.running === true && typeof now.snapshot.peer === 'string' ? now : undefined }, 420_000, 'the second Worker never came up')
    result.steps.secondUpMs = Date.now() - secondBegan
    log(`the second Worker is up after ${result.steps.secondUpMs} ms (reused: ${String(upSecond.snapshot.reused)})`)
    const readyAt = Date.now()

    pkc2 = await PKC({ pkcRpcClientsOptions: [String(upSecond.rpcUrl).replace('ws://localhost:', 'ws://127.0.0.1:')], dataPath: undefined })
    pkc2.on('error', (/** @type {unknown} */ error) => { log(`client 2 error: ${textOf(error)}`) })
    const again = await pkc2.createCommunity({ address })
    again.on('error', (/** @type {unknown} */ error) => { log(`community 2 error: ${textOf(error)}`) })
    again.on('startedstatechange', (/** @type {string} */ state) => { log(`community 2 started state: ${state}`) })
    again.on('updatingstatechange', (/** @type {string} */ state) => { log(`community 2 updating state: ${state}`) })
    again.on('update', () => { log(`community 2 update: updatedAt ${String(again.updatedAt)}`) })
    await again.update().catch((/** @type {unknown} */ error) => { log(`community 2 update(): ${textOf(error)}`) })
    const back = await waitFor(() => (again.updatedAt !== undefined && again.updatedAt > firstUpdatedAt ? again.updatedAt : undefined), backMs, 'the community never published a newer record').catch(() => false)
    result.steps.backAfterMs = back === false ? null : Date.now() - readyAt
    result.steps.after = { updatedAt: again.updatedAt ?? null, state: again.state, startedState: again.startedState ?? null, updatingState: again.updatingState ?? null, communities: pkc2.communities ?? null }
    result.ok = back !== false
    log(`the board ${result.ok ? 'came back' : 'did not come back'}: ${JSON.stringify(result.steps.after)}`)
  } catch (error) {
    result.error = textOf(error)
    log(`FAILED: ${result.error}`)
  } finally {
    await pkc?.destroy().catch(() => {})
    await pkc2?.destroy().catch(() => {})
    if (shell !== undefined) await closeApp(shell.app, shell.stopCounting, result)
    if (server !== undefined) await new Promise((resolve) => { server?.close(() => { resolve(undefined) }) })
    result.totalMs = Date.now() - began
    result.pageLogs = (shell?.pageLogs ?? []).slice(-6000)
    result.log = lines
    writeFileSync(join(RESULTS, `restart-${stamp}.json`), JSON.stringify(result, null, 2))
    writeFileSync(join(RESULTS, 'restart-latest.json'), JSON.stringify(result, null, 2))
    console.log(`[restart] ok=${String(result.ok)} wrote ${join(RESULTS, `restart-${stamp}.json`)}`)
  }
  return result
}

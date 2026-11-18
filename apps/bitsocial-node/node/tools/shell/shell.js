// Go/no-go 2: the same reader as `go-no-go.js`, the host now the app's own page and Worker in the Orivon shell. This script
// serves the built app, opens it in the shell, lets the consent question through, and the page starts the Worker. The
// reader (a real kubo and pkc-js, started here) is given the node's loopback address; the community is created and
// started through the Worker's RPC, and the post goes the way it does in `go-no-go.js`. Run it with `run.js` (`DRIVE_MODE`
// unset): it needs a built Orivon checkout (`ORIVON_MVP_ROOT`), kubo (`KUBO_BIN`) and the built app (`DRIVE_DIST`).
//
// With `busyMs` the run goes on after the first post: the reader posts again and again for that long, the control calls
// the broker receives are kept per second (`busy.control`: mean, peak, seconds above the limiter's 100 a second), and a
// call to each of the page API's `id`, `swarm/peers` and `swarm/addrs/autonat` is timed every 1.5 s (`busy.apiCalls`).

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startKubo } from '../kubo.js'
import { readAndPost, startHostedCommunity, sleep, waitFor } from '../scenario.js'
import { closeApp, controlRate, free, openApp, RESULTS, serveApp } from './harness.js'

const KUBO_BIN = process.env['KUBO_BIN'] ?? 'ipfs'
const P2P_PORT = 4851
export const API_CALLS = ['id', 'swarm/peers', 'swarm/addrs/autonat']

/** The page, with the isolated option put on the node-client call it makes (no internet, the reader kubo as the DHT's start). @param {string} isolatedPeer */
const isolate = (isolatedPeer) => `(() => { const c = globalThis.BitsocialNodeClient; const start = c.startBitsocialNode; globalThis.BitsocialNodeClient = { ...c, startBitsocialNode: (options, deps) => { const given = { ...options, trace: ${JSON.stringify(process.env['DRIVE_TRACE'] ?? 'warn,orivon_ipfs_gateway=info')}, isolated: { bootstrap: [${JSON.stringify(isolatedPeer)}] } }; console.log('[drive] starting the node with trace ' + given.trace + ' and isolated ' + JSON.stringify(given.isolated)); return start(given, deps) } } })()`

/** One timed call of the page API from the app's page: `{ call, ms, status }`, or `{ call, ms, error }`; null when the page did not answer. */
export const timeApiCall = (/** @type {Function} */ inPage, /** @type {string} */ call) => inPage(async (name) => {
  const handle = window.bitsocialNodeApp?.handle
  const began = performance.now()
  try { const answer = await handle.api(name); await answer.text(); return JSON.stringify({ call: name, ms: Math.round(performance.now() - began), status: answer.status }) } catch (error) { return JSON.stringify({ call: name, ms: Math.round(performance.now() - began), error: String(error).slice(0, 120) }) }
}, call, 60_000).then((text) => (text === null ? null : JSON.parse(text)))

/** Mean, median and worst of the call times, per call. @param {Array<{ call: string, ms: number, error?: string }>} calls */
export function apiSummary (calls) {
  return Object.fromEntries(API_CALLS.map((call) => {
    const times = calls.filter((one) => one.call === call).map((one) => one.ms).sort((a, b) => a - b)
    return [call, times.length === 0 ? null : { calls: times.length, failed: calls.filter((one) => one.call === call && one.error !== undefined).length, meanMs: Math.round(times.reduce((sum, ms) => sum + ms, 0) / times.length), medianMs: times[Math.floor(times.length / 2)], worstMs: times.at(-1) }]
  }))
}

/** Runs the go/no-go in the shell once, writes the result under DRIVE_RESULTS and returns it. @param {{ busyMs?: number }} [options] */
export async function runShell ({ busyMs = 0 } = {}) {
  mkdirSync(RESULTS, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const began = Date.now()
  const lines = []
  const log = (line) => { const text = `[${((Date.now() - began) / 1000).toFixed(1)}s] ${line}`; lines.push(text); console.log(text) }
  const dir = mkdtempSync(join(tmpdir(), 'bitsocial-shell-gonogo-'))
  const result = { when: stamp, ok: false, steps: {} }
  let shell
  let server
  let kubo
  let hosted
  const controlCalls = []
  const series = []
  try {
    kubo = await startKubo({ bin: KUBO_BIN, repo: join(dir, 'reader-kubo'), mode: 'loopback', swarmPort: await free(), apiPort: await free(), logLevel: 'error,dht=debug,pubsub=debug,namesys=debug,basichost=info,swarm2=info', logFile: join(RESULTS, `shell-${stamp}.kubo.log`), log })
    result.kuboVersion = await kubo.version()
    if (kubo.loopbackAddress === null) throw new Error('the reader kubo has no loopback address')
    server = await serveApp({ connect: [`127.0.0.1:${kubo.loopbackAddress.split('/')[4]}`], pageScript: isolate(kubo.loopbackAddress) })
    shell = await openApp({ log, controlCalls, series })
    const up = await waitFor(async () => { const now = await shell.snapshot(); if (now?.error != null) throw new Error(`the page could not start the node: ${now.error}`); return now?.snapshot?.running === true && typeof now.snapshot.peer === 'string' && now.rpcUrl !== null ? now : undefined }, 240_000, 'the page never started the node')
    result.steps.workerUpMs = Date.now() - began
    const peer = up.snapshot.peer
    const rpcUrl = up.rpcUrl.replace('ws://localhost:', 'ws://127.0.0.1:')
    log(`the Worker is up: node ${peer}`)
    const address = `/ip4/127.0.0.1/tcp/${P2P_PORT}/p2p/${peer}`
    await kubo.ipfs('swarm', 'connect', address)
    log(`reader kubo ${kubo.peer} connected to ${address}`)

    const hostBegan = Date.now()
    hosted = await startHostedCommunity({ rpcUrl, log, startMs: 240_000 })
    result.steps.hosted = { address: hosted.address, startedMs: hosted.startedMs, controlWhileStarting: controlRate(series, hostBegan, Date.now()) }
    const reader = await readAndPost({ api: kubo.api, address: hosted.address, answer: hosted.answer, log, resolveMs: 240_000, postMs: 240_000, visibleMs: 240_000 })
    result.steps.reader = reader
    result.ok = reader.ok === true

    if (busyMs > 0 && result.ok) {
      const from = Date.now()
      const apiCalls = []
      const posts = []
      let busy = true
      const probing = (async () => { while (busy) { for (const call of API_CALLS) { const timed = await timeApiCall(shell.inPage, call); if (timed !== null) apiCalls.push(timed) } await sleep(1500) } })()
      while (Date.now() - from < busyMs) {
        try { posts.push((await readAndPost({ api: kubo.api, address: hosted.address, answer: hosted.answer, log, resolveMs: 60_000, postMs: 60_000, visibleMs: 60_000 })).times) } catch (error) { log(`a busy-window post failed: ${error instanceof Error ? error.message : String(error)}`); await sleep(2000) }
      }
      busy = false
      await probing
      result.steps.busy = { ms: Date.now() - from, posts: posts.length, postTimes: posts, control: controlRate(series, from, Date.now()), apiCalls: apiSummary(apiCalls), slowApiCalls: apiCalls.filter((one) => one.ms >= 5000 || one.error !== undefined).slice(0, 40) }
      log(`busy window: ${JSON.stringify({ control: result.steps.busy.control, api: result.steps.busy.apiCalls })}`)
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    log(`FAILED: ${result.error}`)
    if (kubo !== undefined) {
      const peers = (await kubo.ipfs('swarm', 'peers', '-v').catch((e) => String(e))).split('\n')
      result.readerPeers = peers
      result.readerPubsub = await kubo.ipfs('pubsub', 'ls').catch((e) => String(e))
      log(`reader peers at the end: ${JSON.stringify(peers)}`)
    }
  } finally {
    await hosted?.stop().catch(() => {})
    if (shell !== undefined) {
      result.controlCalls = controlCalls.slice(0, 200)
      await closeApp(shell.app, shell.stopCounting, result)
    }
    if (server !== undefined) await new Promise((resolve) => { server.close(() => { resolve() }) })
    await kubo?.stop().catch(() => {})
    result.totalMs = Date.now() - began
    result.pageLogs = (shell?.pageLogs ?? []).slice(-4000)
    result.log = lines
    writeFileSync(join(RESULTS, `shell-${stamp}.json`), JSON.stringify(result, null, 2))
    writeFileSync(join(RESULTS, 'shell-latest.json'), JSON.stringify(result, null, 2))
    console.log(`[go-no-go] ok=${result.ok} wrote ${join(RESULTS, `shell-${stamp}.json`)}`)
    return result
  }
}

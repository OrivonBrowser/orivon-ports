// A board hosted on the real network from the Orivon shell: the host is the app's page and Worker with the node's own defaults
// (the public DHT, the four HTTP routers, a hole punch through relays), and the reader runs elsewhere (`../network-reader.js` on a
// public machine). This script serves the built app, opens it in the shell, creates and starts a community through the Worker's RPC,
// writes its address and challenge answer to `DRIVE_NET_OUT.community` and the peer to `DRIVE_NET_OUT.peer` for the reader, then
// keeps the community started for `minutes` and samples every 10 s: what the page knows of the node (reachability and what it
// rests on, the hole punch counts, peers, addresses), the control calls the broker received, and the time of a page API call.
// Run it with `run.js` and `DRIVE_MODE=network`; heavy gives a run its own network namespace, which a punch may not cross (README.md
// section Go/no-go), so the run that measures the punch sets `HEAVY_NETNS=0`, heavy's own switch.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHostedCommunity, sleep, waitFor } from '../scenario.js'
import { apiSummary, timeApiCall } from './shell.js'
import { closeApp, controlRate, openApp, RESULTS, serveApp } from './harness.js'

/** @param {{ minutes?: number }} [options] */
export async function runNetwork ({ minutes = 8 } = {}) {
  mkdirSync(RESULTS, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const began = Date.now()
  const out = process.env['DRIVE_NET_OUT'] ?? join(RESULTS, `network-${stamp}`)
  const lines = []
  const log = (line) => { const text = `[${((Date.now() - began) / 1000).toFixed(1)}s] ${line}`; lines.push(text); console.log(text) }
  const result = { when: stamp, mode: 'network', ok: false, samples: [] }
  let shell
  let server
  let hosted
  const series = []
  try {
    server = await serveApp()
    shell = await openApp({ log, series })
    const up = await waitFor(async () => { const now = await shell.snapshot(); if (now?.error != null) throw new Error(`the page could not start the node: ${now.error}`); return now?.snapshot?.running === true && typeof now.snapshot.peer === 'string' && now.rpcUrl !== null ? now : undefined }, 240_000, 'the page never started the node')
    result.workerUpMs = Date.now() - began
    result.peer = up.snapshot.peer
    writeFileSync(`${out}.peer`, `${result.peer}\n`)
    log(`the Worker is up: node ${result.peer}`)
    hosted = await startHostedCommunity({ rpcUrl: up.rpcUrl.replace('ws://localhost:', 'ws://127.0.0.1:'), log, startMs: 300_000 })
    result.community = { address: hosted.address, startedMs: hosted.startedMs, startedAtMs: Date.now() - began }
    writeFileSync(`${out}.community`, `${hosted.address} ${hosted.answer}\n`)
    log(`COMMUNITY ${hosted.address}`)

    const from = Date.now()
    const apiCalls = []
    while (Date.now() - from < minutes * 60_000) {
      await sleep(10_000)
      const at = Date.now()
      const now = (await shell.snapshot())?.snapshot ?? null
      const timed = await Promise.all(['swarm/addrs/autonat', 'swarm/peers'].map((call) => timeApiCall(shell.inPage, call)))
      for (const one of timed) if (one !== null) apiCalls.push(one)
      const sample = { atS: Math.round((at - began) / 1000), reachability: now?.reachability ?? null, basis: now?.basis ?? null, punch: now?.punch ?? null, peers: now?.peers ?? null, external: now?.external ?? [], apiMs: Object.fromEntries(timed.filter((one) => one !== null).map((one) => [one.call, one.ms])), control: controlRate(series, at - 10_000, at) }
      result.samples.push(sample)
      log(`sample ${JSON.stringify(sample)}`)
    }
    result.api = apiSummary(apiCalls)
    result.control = controlRate(series, from, Date.now())
    result.ok = true
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    log(`FAILED: ${result.error}`)
  } finally {
    await hosted?.stop().catch(() => {})
    if (shell !== undefined) await closeApp(shell.app, shell.stopCounting, result)
    if (server !== undefined) await new Promise((resolve) => { server.close(() => { resolve() }) })
    result.totalMs = Date.now() - began
    result.pageLogs = (shell?.pageLogs ?? []).slice(-1500)
    result.log = lines
    writeFileSync(`${out}.json`, JSON.stringify(result, null, 2))
    writeFileSync(join(RESULTS, 'network-latest.json'), JSON.stringify(result, null, 2))
    console.log(`[network] ok=${result.ok} wrote ${out}.json`)
    return result
  }
}

// The node's start in the Orivon shell, alone: the built app is served, the shell opens it and the page starts the Worker with the
// node's own defaults (the public DHT and the four HTTP routers, no reader). The result says how long the node took to answer, how
// many times the supervisor started it again and why (`restarts`, with the `os error 33` ones counted as `emfile`: the descriptors
// the component could not get), and which of the Worker's and the page's console lines reached the shell's own output, which is
// what a bug report from orivon://report carries (`mainLines`). Run it with `run.js` and `DRIVE_MODE=start`; `DRIVE_PROBE=1` adds one
// line of each console level to the Worker and to the page, to see which levels get that far.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sleep, waitFor } from '../scenario.js'
import { closeApp, openApp, RESULTS, serveApp } from './harness.js'

const WORKER_PROBE = "console.log('PROBE worker log'); console.info('PROBE worker info'); console.warn('PROBE worker warn'); console.error('PROBE worker error'); try { process.stderr.write('PROBE worker stderr\\n') } catch { /* no stderr */ }\n"
const PAGE_PROBE = "console.log('PROBE page log'); console.info('PROBE page info'); console.warn('PROBE page warn'); console.error('PROBE page error')"

/** Starts the app once and reports how the node's start went. @param {{ probe?: boolean, settleMs?: number }} [options] */
export async function runStart ({ probe = process.env['DRIVE_PROBE'] === '1', settleMs = 45_000 } = {}) {
  mkdirSync(RESULTS, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const began = Date.now()
  const lines = []
  const log = (line) => { const text = `[${((Date.now() - began) / 1000).toFixed(1)}s] ${line}`; lines.push(text); console.log(text) }
  const result = { when: stamp, mode: 'start', ok: false }
  let shell
  let server
  try {
    server = await serveApp(probe ? { pageScript: PAGE_PROBE, serverPrefix: WORKER_PROBE } : {})
    shell = await openApp({ log })
    const up = await waitFor(async () => { const now = await shell.snapshot(); if (now?.error != null) throw new Error(`the page could not start the node: ${now.error}`); return now?.snapshot?.running === true && typeof now.snapshot.peer === 'string' ? now : undefined }, 240_000, 'the page never started the node')
    result.upMs = Date.now() - began
    result.peer = up.snapshot.peer
    log(`the node is up after ${result.upMs} ms`)
    await sleep(settleMs)
    const after = await shell.snapshot()
    result.snapshot = after?.snapshot ?? null
    result.ok = true
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    log(`FAILED: ${result.error}`)
  } finally {
    if (shell !== undefined) await closeApp(shell.app, shell.stopCounting, result)
    if (server !== undefined) await new Promise((resolve) => { server.close(() => { resolve() }) })
    const pageLogs = shell?.pageLogs ?? []
    const states = pageLogs.filter((line) => /\[bitsocial-node\] node (starting|up|restarting|failed)/.test(line))
    result.nodeStates = states.map((line) => line.replace(/^\[[^\]]*\] \w+: /, '').slice(0, 260))
    result.restarts = states.filter((line) => /node restarting/.test(line) && !/node restarting\s*$/.test(line)).length
    result.emfile = pageLogs.filter((line) => /os error 33|No file descriptors available|EMFILE/.test(line)).length
    result.startFailed = pageLogs.some((line) => /node failed/.test(line))
    result.totalMs = Date.now() - began
    result.pageLogs = pageLogs.slice(-400)
    result.log = lines
    writeFileSync(join(RESULTS, `start-${stamp}.json`), JSON.stringify(result, null, 2))
    writeFileSync(join(RESULTS, 'start-latest.json'), JSON.stringify(result, null, 2))
    console.log(`[start] ok=${result.ok} upMs=${String(result.upMs)} restarts=${result.restarts} emfile=${result.emfile} wrote ${join(RESULTS, `start-${stamp}.json`)}`)
    return result
  }
}

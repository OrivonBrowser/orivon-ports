// The 5chan board manager in the Orivon shell: the built app is served and opened, the page starts the Worker, and a pkc-js client
// of this process (the Worker's RPC is a real loopback socket) plays the app. The page turns the manager of a new board on through
// `handle.manager` (the control channel, with the page's own key), the client posts, and the board's published pages say what the
// manager did: a thread limit of 3, and the 4th thread archives the oldest. The result also says whether the Worker's own client
// reached its own RPC port under the shell's Node shim (the manager is `running`, which it cannot be otherwise) and which of the
// manager's lines reached the shell's output, which is what orivon://report carries. Run it with `run.js` and `DRIVE_MODE=manager`.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { boardClient, shortOf, threadsOf } from '../board-client.js'
import { waitFor } from '../scenario.js'
import { closeApp, openApp, RESULTS, serveApp } from './harness.js'

/** The app's gateway port, from its manifest and the node client's defaults. */
const GATEWAY_PORT = 6473

/** Runs the board manager in the shell once, writes the result under DRIVE_RESULTS and returns it. */
export async function runManager () {
  mkdirSync(RESULTS, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const began = Date.now()
  const lines = []
  const log = (line) => { const text = `[${((Date.now() - began) / 1000).toFixed(1)}s] ${line}`; lines.push(text); console.log(text) }
  const result = { when: stamp, mode: 'manager', ok: false, steps: {} }
  let shell
  let server
  let client
  const check = (name, held, detail) => { result.steps[name] = { held, detail }; log(`${held ? 'HELD' : 'FAILED'}: ${name} ${JSON.stringify(detail)}`); if (!held) throw new Error(`check failed: ${name}`) }
  try {
    server = await serveApp({})
    shell = await openApp({ log })
    const control = async (call, body = {}) => {
      // The call the dashboard makes: the answer as JSON, or `{ error, status }` for a refusal.
      const text = await shell.inPage(async (arg) => {
        try { return JSON.stringify(await window.bitsocialNodeApp.handle.manager(arg.call, arg.body)) } catch (error) { return JSON.stringify({ error: String(error.message), status: error.status ?? null }) }
      }, { call, body }, 60_000, null)
      return text === null ? { error: 'the page did not answer', status: null } : JSON.parse(text)
    }
    const up = await waitFor(async () => { const now = await shell.snapshot(); if (now?.error != null) throw new Error(`the page could not start the node: ${now.error}`); return now?.snapshot?.running === true && typeof now.snapshot.peer === 'string' && now.rpcUrl !== null ? now : undefined }, 240_000, 'the page never started the node')
    result.steps.workerUpMs = Date.now() - began
    const rpcUrl = up.rpcUrl.replace('ws://localhost:', 'ws://127.0.0.1:')
    log(`the Worker is up: node ${up.snapshot.peer}`)

    client = await boardClient(rpcUrl, log)
    const board = await client.createBoard('Shell board', true)
    const before = await control('boards')
    check('the page lists the board the node hosts, with no manager on it', before.boards?.some((one) => one.address === board.address && one.hosted === true && one.managed === false) === true, before.error ?? before.boards?.map((one) => [one.address.slice(-6), one.managed, one.state]))

    const enabled = await control('enable', { address: board.address, config: { perPage: 3, pages: 1, archivePurgeSeconds: 3600 } })
    check('the page turns the manager on', enabled.error === undefined && enabled.enabled === true, enabled)
    let last = null
    const running = await waitFor(async () => { last = await control('board', { address: board.address }); return last.state === 'running' ? last : undefined }, 240_000, 'the manager did not reach running').catch((error) => {
      throw new Error(`${error.message}; the control API said ${JSON.stringify({ state: last?.state, failures: last?.failures, lastError: last?.lastError })}`)
    })
    result.steps.managerRunningMs = Date.now() - began
    check('the manager runs inside the Worker, as a client of its own RPC port', running.state === 'running' && running.managed === true, { state: running.state, failures: running.failures, since: running.since })

    const refused = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/orivon/manager/boards`, { method: 'POST' }).then((answer) => answer.status, (error) => String(error))
    check('a call without the key is refused', refused === 401 || refused === 403, refused)

    const reader = await client.follow(board.address)
    const cids = []
    for (const title of ['S1', 'S2', 'S3']) cids.push(await client.thread(board.address, title))
    await client.pagesShow(reader, (threads) => threads.length === 3, 180_000, 'three threads on the page')
    check('three threads under the limit of 3 are all open', threadsOf(reader).every((one) => one.archived !== true), threadsOf(reader).map((one) => shortOf(one.cid)))
    cids.push(await client.thread(board.address, 'S4'))
    await client.pagesShow(reader, (threads) => threads.find((one) => one.cid === cids[0])?.archived === true, 300_000, 'the oldest thread archived')
    const now = threadsOf(reader)
    check('the 4th thread archives the oldest, and only the oldest', now.filter((one) => one.archived === true).map((one) => one.cid).join() === cids[0] && now.length === 4, now.map((one) => [one.title, one.archived ?? false]))
    const after = await control('board', { address: board.address })
    check('the control API counts the archived thread', after.archivedThreads === 1 && after.state === 'running', { archivedThreads: after.archivedThreads, state: after.state })
    result.ok = true
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    log(`FAILED: ${result.error}`)
  } finally {
    await client?.destroy()
    if (shell !== undefined) await closeApp(shell.app, shell.stopCounting, result)
    if (server !== undefined) await new Promise((resolve) => { server.close(() => { resolve() }) })
    const pageLogs = shell?.pageLogs ?? []
    result.managerPageLines = pageLogs.filter((line) => /board manager/i.test(line)).slice(-40)
    result.managerMainLines = String(result.main ?? '').split('\n').filter((line) => /board manager/i.test(line)).slice(-40)
    result.totalMs = Date.now() - began
    result.pageLogs = pageLogs.slice(-300)
    result.log = lines
    writeFileSync(join(RESULTS, `manager-${stamp}.json`), JSON.stringify(result, null, 2))
    writeFileSync(join(RESULTS, 'manager-latest.json'), JSON.stringify(result, null, 2))
    console.log(`[manager] ok=${result.ok} wrote ${join(RESULTS, `manager-${stamp}.json`)}`)
    return result
  }
}

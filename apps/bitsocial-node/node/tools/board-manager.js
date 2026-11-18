// The 5chan board manager inside the Worker under plain Node (`host.js` with the board manager bundled, over the node component
// run by wasmtime or a native build). One pkc-js client plays the app: it creates boards, turns the manager on through the control
// calls, posts, and reads each result from the board's own pages, never from the manager's log:
//
//   A  thread limit 3 and a short purge delay: the 4th thread archives the oldest, which is purged after its delay
//   B  bump limit 2: the 3rd reply to an older thread does not lift it over a newer thread
//   C  the same posts with the default bump limit: the 3rd reply lifts the thread, so B's order is the limit's doing
//   D  a board with no page sort and thread limit 3: its 4th thread archives the oldest as well
//
// Then the Worker is killed with no stop message and started again over the same files, and the managers come back by themselves:
// D's 5th thread archives its oldest once more. Prints one JSON result and exits 0 when every check held.
//
//   IPFS_NODE_BIN=<node/tools/wasmtime-node.js or a native node> [WASMTIME=.. WASM=.. WASM_DIRS=".."] node board-manager.js [--keep] [--results <dir>]

import { fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleBoardManager } from '../../build/board-manager.mjs'
import { boardClient, shortOf, textOf, threadsOf } from './board-client.js'
import { sleep, waitFor } from './scenario.js'

const here = dirname(fileURLToPath(import.meta.url))
const argValue = (/** @type {string} */ name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const keep = process.argv.includes('--keep')
const nodeBin = process.env['IPFS_NODE_BIN']
if (nodeBin === undefined) throw new Error('IPFS_NODE_BIN names the node binary, or node/tools/wasmtime-node.js')
const binding = join(here, '..', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
if (!existsSync(binding)) throw new Error(`${binding} is missing: \`npm rebuild better-sqlite3 --prefix apps/bitsocial-node/node\``)

const PURGE_AFTER_S = 8

const freePort = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = /** @type {import('node:net').AddressInfo} */ (server.address()); server.close(() => { resolve(port) }) }) })

const dir = await mkdtemp(join(process.env['BM_OUT'] ?? tmpdir(), 'bitsocial-board-manager-'))
const logPath = join(dir, 'run.log')
const out = createWriteStream(logPath)
const started = Date.now()
const log = (/** @type {string} */ line) => { const text = `[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`; out.write(`${text}\n`); console.error(text) }

const [rpc, gateway, fakeKubo, nodeApi, p2p] = await Promise.all(Array.from({ length: 5 }, freePort))
const authKey = randomBytes(16).toString('hex')
const files = join(dir, 'files')
await mkdir(files, { recursive: true })
const config = { authKey, files, ports: { rpc, gateway, kubo: fakeKubo, nodeApi, p2p }, origins: [], trace: 'warn' }
const rpcUrl = `ws://127.0.0.1:${rpc}/${authKey}`
const bundle = await bundleBoardManager()

/** One call of the control API, as a page makes it. @param {string} call @param {Record<string, unknown>} [body] */
async function control (call, body = {}) {
  const answer = await fetch(`http://127.0.0.1:${gateway}/orivon/manager/${call}`, { method: 'POST', headers: { Authorization: `Bearer ${authKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const value = await answer.json()
  if (!answer.ok) throw new Error(`${call}: ${answer.status} ${JSON.stringify(value)}`)
  return value
}

/** @param {string} label */
function startHost (label) {
  const host = fork(join(here, 'host.js'), [], {
    silent: true, detached: true, serialization: 'advanced',
    env: { ...process.env, BITSOCIAL_NODE: JSON.stringify(config), IPFS_NODE_BIN: nodeBin, BOARD_MANAGER_BUNDLE: bundle, PURGE_SWEEP_INTERVAL_SECONDS: '2', NODE_LOG_FILE: join(dir, `${label}-node.log`), NODE_ENV: 'production' }
  })
  const messages = /** @type {Array<Record<string, any>>} */ ([])
  for (const stream of [host.stdout, host.stderr]) stream?.on('data', (chunk) => { for (const line of String(chunk).split('\n')) if (line.trim() !== '') out.write(`  ${label}: ${line.slice(0, 700)}\n`) })
  host.on('message', (/** @type {Record<string, any>} */ message) => { messages.push(message); if (message['type'] !== 'status') log(`${label} says ${JSON.stringify(message).slice(0, 300)}`) })
  host.once('exit', (code) => { log(`${label} ended (${String(code)})`) })
  return { host, ready: () => waitFor(() => messages.find((message) => message['type'] === 'ready' || message['type'] === 'failed'), 240_000, `${label} never said ready`) }
}

/** @param {string} address */
const stateOf = (address) => {
  try { return JSON.parse(readFileSync(join(files, 'board-manager', 'boards', address, 'state.json'), 'utf8')) } catch { return null }
}

/** Waits for the control API to say a board's manager is running. @param {string} address */
const managerRuns = (address) => waitFor(async () => { const board = await control('board', { address }).catch(() => null); return board?.state === 'running' ? board : undefined }, 240_000, `${address}: the manager is not running`)

const result = /** @type {Record<string, any>} */ ({ when: new Date().toISOString(), ok: false, checks: {}, dir })
const check = (/** @type {string} */ name, /** @type {boolean} */ held, /** @type {unknown} */ detail) => { result.checks[name] = { held, detail }; log(`${held ? 'HELD' : 'FAILED'}: ${name} ${JSON.stringify(detail)}`); if (!held) throw new Error(`check failed: ${name}`) }

/** @type {ReturnType<typeof startHost> | null} */
let first = null
/** @type {ReturnType<typeof startHost> | null} */
let second = null
try {
  first = startHost('first')
  const ready = await first.ready()
  if (ready['type'] !== 'ready') throw new Error(`the Worker failed: ${JSON.stringify(ready)}`)
  log('the Worker is ready')

  const client = await boardClient(rpcUrl, log)
  const boardA = await client.createBoard('A thread limit', true)
  const boardB = await client.createBoard('B bump limit 2', true)
  const boardC = await client.createBoard('C default bump limit', true)
  const boardD = await client.createBoard('D no page sort', false)

  const listed = await control('boards')
  check('boards lists the boards the node hosts, none managed yet', listed.boards.length === 4 && listed.boards.every((/** @type {any} */ board) => board.hosted && !board.managed), listed.boards.map((/** @type {any} */ board) => [board.address.slice(-6), board.managed, board.state]))
  await control('enable', { address: boardA.address, config: { perPage: 3, pages: 1, archivePurgeSeconds: PURGE_AFTER_S } })
  await control('enable', { address: boardB.address, config: { bumpLimit: 2 } })
  await control('enable', { address: boardC.address })
  await control('enable', { address: boardD.address, config: { perPage: 3, pages: 1, archivePurgeSeconds: 3600 } })
  const running = await Promise.all([boardA, boardB, boardC, boardD].map((board) => managerRuns(board.address)))
  check('every manager runs after it is turned on', running.every((board) => board.state === 'running' && board.enabled), running.map((board) => [board.address.slice(-6), board.state, board.config]))

  const readerA = await client.follow(boardA.address)
  const readerB = await client.follow(boardB.address)
  const readerC = await client.follow(boardC.address)
  const readerD = await client.follow(boardD.address)

  // The bump limit is applied through the board's page sort, by the manager's own first update: B's sort takes the limit 2, the default 300 stays on C.
  const limitOf = (/** @type {any} */ reader) => reader.pageSorts?.posts?.active?.publicOptions?.bumpLimit
  await waitFor(() => (limitOf(readerB) === '2' ? true : undefined), 120_000, `B's published sort never took bumpLimit 2 (${String(limitOf(readerB))})`)
  check('the manager writes the board\'s bump limit into its page sort', limitOf(readerB) === '2' && limitOf(readerC) === '300' && limitOf(readerD) === undefined, { B: limitOf(readerB), C: limitOf(readerC), D: limitOf(readerD) })

  const a = []
  const scenarioA = async () => {
    for (const title of ['A1', 'A2', 'A3']) a.push(await client.thread(boardA.address, title))
    await client.pagesShow(readerA, (threads) => threads.length === 3, 120_000, 'A: three threads')
    check('A: three threads under the limit of 3 are all open', threadsOf(readerA).every((one) => one['archived'] !== true) && stateOf(boardA.address)?.archivedThreads !== undefined && Object.keys(stateOf(boardA.address).archivedThreads).length === 0, threadsOf(readerA).map((one) => shortOf(one['cid'])))
    a.push(await client.thread(boardA.address, 'A4'))
    await client.pagesShow(readerA, (threads) => threads.find((one) => one['cid'] === a[0])?.['archived'] === true, 240_000, 'A: the oldest thread archived')
    const now = threadsOf(readerA)
    check('A: the 4th thread archives the oldest, and only the oldest', now.filter((one) => one['archived'] === true).map((one) => one['cid']).join() === a[0] && now.length === 4, now.map((one) => [one['title'], one['archived'] ?? false]))
    const sinceArchive = Date.now()
    await client.pagesShow(readerA, (threads) => !threads.some((one) => one['cid'] === a[0]), 240_000, 'A: the archived thread purged')
    const afterS = (Date.now() - sinceArchive) / 1000
    const state = stateOf(boardA.address)
    check('A: the archived thread is purged after its delay and leaves the pages', !threadsOf(readerA).some((one) => one['cid'] === a[0]) && Object.keys(state?.archivedThreads ?? { x: 1 }).length === 0, { purgeAfterSeconds: PURGE_AFTER_S, seenGoneAfterSeconds: afterS, remaining: threadsOf(readerA).map((one) => one['title']) })
    const board = await control('board', { address: boardA.address })
    check('A: the control API counts no archived thread once it is purged', board.archivedThreads === 0 && board.capacity === 3, { archivedThreads: board.archivedThreads, capacity: board.capacity })
  }

  /** @param {{ address: string }} board @param {any} reader @param {boolean} limited */
  const scenarioBump = async (board, reader, limited) => {
    const t1 = await client.thread(board.address, 'T1')
    const t2 = await client.thread(board.address, 'T2')
    await client.reply(board.address, t1, 'r1')
    await client.reply(board.address, t1, 'r2')
    const t3 = await client.thread(board.address, 'T3')
    await client.pagesShow(reader, (threads) => threads.map((one) => one['cid']).join() === [t3, t1, t2].join(), 180_000, `${board.address}: T3 on top, T1 below it after two replies`)
    await client.reply(board.address, t1, 'r3')
    // Two replies fill the limit of 2; the third must not lift T1 over T3. With the default limit it does. The order is read once the page
    // counts the third reply, so a board that had not yet published it cannot pass for one that held the thread down.
    await client.pagesShow(reader, (threads) => threads.find((one) => one['cid'] === t1)?.['replyCount'] === 3, 180_000, `${board.address}: the page counts the third reply`)
    const want = limited ? [t3, t1, t2] : [t1, t3, t2]
    await client.pagesShow(reader, (threads) => threads.map((one) => one['cid']).join() === want.join(), 60_000, `${board.address}: the order after the third reply`).catch(() => {})
    return { order: threadsOf(reader).map((one) => one['title']), held: threadsOf(reader).map((one) => one['cid']).join() === want.join() }
  }

  const scenarioD = async () => {
    const d = []
    for (const title of ['D1', 'D2', 'D3', 'D4']) d.push(await client.thread(boardD.address, title))
    await client.pagesShow(readerD, (threads) => threads.find((one) => one['cid'] === d[0])?.['archived'] === true, 240_000, 'D: the oldest thread archived')
    const now = threadsOf(readerD)
    check('D: with no page sort the 4th thread still archives the oldest', now.filter((one) => one['archived'] === true).map((one) => one['cid']).join() === d[0], now.map((one) => [one['title'], one['archived'] ?? false]))
    return d
  }

  const [, bumpB, bumpC, dThreads] = await Promise.all([scenarioA(), scenarioBump(boardB, readerB, true), scenarioBump(boardC, readerC, false), scenarioD()])
  check('B: past the bump limit of 2 a reply does not lift the thread over a newer one', bumpB.held, bumpB.order)
  check('C: the same posts with the default limit do lift it, so B\'s order is the limit\'s doing', bumpC.held, bumpC.order)

  // The managers come back with the Worker, with nothing asked of them.
  await client.destroy()
  if (first.host.pid !== undefined) { try { process.kill(-first.host.pid, 'SIGKILL') } catch { /* gone */ } }
  await waitFor(() => (first?.host.exitCode !== null || first?.host.signalCode !== null ? true : undefined), 60_000, 'the first Worker did not end')
  await sleep(2500)
  second = startHost('second')
  const again = await second.ready()
  if (again['type'] !== 'ready') throw new Error(`the second Worker failed: ${JSON.stringify(again)}`)
  const back = await Promise.all([boardA, boardB, boardC, boardD].map((board) => managerRuns(board.address)))
  check('after a Worker restart every manager is running again with nothing asked of it', back.every((board) => board.state === 'running' && board.enabled && board.managed), back.map((board) => [board.address.slice(-6), board.state]))

  const client2 = await boardClient(rpcUrl, log)
  const readerD2 = await client2.follow(boardD.address)
  const d5 = await client2.thread(boardD.address, 'D5')
  await client.pagesShow(readerD2, (threads) => threads.find((one) => one['cid'] === dThreads[1])?.['archived'] === true, 300_000, 'D: the manager that came back archived D2')
  const afterRestart = threadsOf(readerD2)
  check('after the restart the manager archives again: D5 archives D2', afterRestart.filter((one) => one['archived'] === true).map((one) => one['title']).sort().join() === 'D1,D2' && afterRestart.some((one) => one['cid'] === d5), afterRestart.map((one) => [one['title'], one['archived'] ?? false]))

  const off = await control('disable', { address: boardD.address })
  check('disable stops the manager and keeps its config', off.state === 'off' && off.enabled === false && off.config.perPage === 3, { state: off.state, enabled: off.enabled })
  await client2.destroy()
  result.ok = true
} catch (error) {
  result.error = textOf(error)
  log(`FAILED: ${result.error}`)
} finally {
  for (const run of [first, second]) {
    if (run?.host.pid !== undefined) { try { process.kill(-run.host.pid, 'SIGKILL') } catch { /* gone */ } }
  }
  out.end()
  result.log = logPath
  const into = argValue('--results')
  if (into !== undefined) { await mkdir(into, { recursive: true }); const { copyFile, writeFile } = await import('node:fs/promises'); await copyFile(logPath, join(into, 'board-manager-run.log')); await writeFile(join(into, 'board-manager-result.json'), JSON.stringify(result, null, 2)) }
  console.log(JSON.stringify(result, null, 2))
  if (!keep && result.ok) await rm(dir, { recursive: true, force: true })
  process.exit(result.ok ? 0 : 1)
}

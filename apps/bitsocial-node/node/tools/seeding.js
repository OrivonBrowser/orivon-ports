// Seeding between two Workers under plain Node (`host.js`), loopback only: A hosts a community and holds a place on a relay (the kubo
// that also plays the reader who posts, as a person behind a router names one: what lets A announce what it hosts), and a reader's post
// lands in it. B, a second Worker, follows the community with seeding on and asks that kubo's routing API for providers, and holds the
// record, whose first page carries the post. A is killed. A third client that has none of the content, a fresh kubo that dials only B,
// still loads the record from B. Seeding is then turned off on B, and a fourth fresh kubo cannot load the record from B any more.
// The node must be a native build: a WebAssembly component asks HTTP routers over https only, which loopback has none of.
//
//   IPFS_NODE_BIN=<a native node binary> [KUBO_BIN=<kubo 0.43.x>] node seeding.js [--keep] [--results <dir>]

import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { plainWorkers, textOf } from './plain-workers.js'
import { readAndPost, sleep, startHostedCommunity, waitFor } from './scenario.js'

const here = dirname(fileURLToPath(import.meta.url))
const argValue = (/** @type {string} */ name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const keep = process.argv.includes('--keep')
const nodeBin = process.env['IPFS_NODE_BIN']
if (nodeBin === undefined) throw new Error('IPFS_NODE_BIN names the node binary, or node/tools/wasmtime-node.js')
const kuboBin = process.env['KUBO_BIN'] ?? 'ipfs'
const binding = join(here, '..', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
if (!existsSync(binding)) throw new Error(`${binding} is missing: \`npm rebuild better-sqlite3 --prefix apps/bitsocial-node/node\``)


const dir = await mkdtemp(join(process.env['SEEDING_OUT'] ?? tmpdir(), 'bitsocial-seeding-'))
const logPath = join(dir, 'run.log')
const out = createWriteStream(logPath)
const started = Date.now()
const log = (/** @type {string} */ line) => { const text = `[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`; out.write(`${text}\n`); console.error(text) }
const result = /** @type {Record<string, any>} */ ({ when: new Date().toISOString(), ok: false, checks: {}, dir })
const check = (/** @type {string} */ name, /** @type {boolean} */ held, /** @type {unknown} */ detail) => { result.checks[name] = { held, detail }; log(`${held ? 'HELD' : 'FAILED'}: ${name} ${JSON.stringify(detail)}`); if (!held) throw new Error(`check failed: ${name}`) }

const { startWorker, startKubo: freshKubo } = plainWorkers({ dir, log, out, nodeBin, kuboBin })

/** What B's seeding file says it holds. @param {{ files: string }} worker */
const heldOf = (worker) => {
  try { return JSON.parse(readFileSync(join(worker.files, 'seeding', 'state.json'), 'utf8')).held ?? {} } catch { return {} }
}

/** Whether a client can load a CID within `seconds`. @param {Awaited<ReturnType<typeof startKubo>>} kubo @param {string} cid @param {number} seconds */
async function loads (kubo, cid, seconds) {
  try { return { ok: true, text: await kubo.ipfs('cat', cid, `--timeout=${String(seconds)}s`) } } catch (error) { return { ok: false, text: textOf(error).slice(0, 200) } }
}

/** What the loopback network looks like when B could not load what A hosts: who each side is connected to and who the relay kubo knows as a provider. @param {string} path */
async function diagnose (path) {
  const note = async (/** @type {string} */ name, /** @type {() => Promise<unknown>} */ read) => { try { log(`diagnose ${name}: ${JSON.stringify(await read()).slice(0, 1500)}`) } catch (error) { log(`diagnose ${name}: ${textOf(error).slice(0, 300)}`) } }
  await note('poster peers', async () => (await poster.ipfs('swarm', 'peers')).split('\n'))
  await note('poster resolves the record', async () => poster.ipfs('resolve', path, '--timeout=20s'))
  await note('poster finds providers', async () => (await poster.ipfs('routing', 'findprovs', (await poster.ipfs('resolve', path, '--timeout=20s')).replace('/ipfs/', ''), '--timeout=20s')).split('\n'))
  await note('providers of the pages the record names', async () => {
    const record = JSON.parse(await poster.ipfs('cat', (await poster.ipfs('resolve', path, '--timeout=20s')).replace('/ipfs/', ''), '--timeout=20s'))
    const cids = [...new Set(JSON.stringify([record.posts?.pageCids ?? {}, record.postUpdates ?? {}]).match(/baf[a-z0-9]{50,}|Qm[A-Za-z0-9]{44}/g) ?? [])]
    return Promise.all(cids.map(async (cid) => {
      const v1 = await poster.ipfs('cid', 'format', '-v', '1', '-b', 'base32', cid)
      const answer = await fetch(`${poster.routerUrl}/routing/v1/providers/${v1}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
      return { cid, v1, providers: (await poster.ipfs('routing', 'findprovs', cid, '--timeout=10s').catch((/** @type {unknown} */ error) => textOf(error))).split('\n'), routerAnswer: answer.status, routerBody: (await answer.text()).slice(0, 500) }
    }))
  })
  await note('B peers', async () => b.api('swarm/peers'))
  await note('B reach', async () => b.call('reach', 'state'))
  await note('A reach', async () => a.call('reach', 'state'))
}

/** @type {Array<{ kill: () => void }>} */
const workers = []
/** @type {Array<{ stop: () => Promise<void> }>} */
const kubos = []
/** @type {Awaited<ReturnType<typeof freshKubo>>} */
let poster
/** @type {Awaited<ReturnType<typeof startWorker>>} */
let a
/** @type {Awaited<ReturnType<typeof startWorker>>} */
let b
try {
  poster = await freshKubo('poster-kubo', { relayService: true })
  kubos.push(poster)
  if (poster.loopbackAddress === null) throw new Error('the poster kubo has no loopback address')
  a = await startWorker('A', [poster.loopbackAddress], poster.loopbackAddress)
  workers.push(a)
  const hosted = await startHostedCommunity({ rpcUrl: a.rpcUrl, log })
  const reach = await waitFor(async () => { const one = await a.call('reach', 'state'); return one.relay.holds ? one : undefined }, 90_000, 'A never held a place on the relay')
  check('A holds a place on the relay it names, which is what lets it announce what it hosts', reach.relay.holds === true && reach.circuits.some((/** @type {any} */ one) => one.named), { relay: reach.relay.address, circuits: reach.circuits.length })
  b = await startWorker('B', [poster.loopbackAddress, a.address], undefined, poster.routerUrl === null ? [] : [poster.routerUrl])
  workers.push(b)

  const before = await b.call('seeding', 'state')
  check('seeding is off by default and holds nothing', before.enabled === false && before.usedBytes === 0, before)
  await b.call('seeding', 'follow', { addresses: [hosted.address] })
  const enabled = await b.call('seeding', 'enable')
  check('turning it on lists the followed community', enabled.enabled === true && enabled.communities.some((/** @type {any} */ one) => one.address === hosted.address && one.origin === 'followed'), enabled.communities)

  const post = await readAndPost({ api: poster.api, address: hosted.address, answer: hosted.answer, log })
  let lastLook = 0
  const held = await waitFor(async () => {
    // A record that changed is seen at the next pass: a look is asked for now and then, as "Check now" does.
    if (Date.now() - lastLook > 20_000) { lastLook = Date.now(); await b.call('seeding', 'run').catch(() => {}) }
    const one = heldOf(b)[hosted.address]
    const record = one?.pins.find((/** @type {any} */ pin) => pin.name === 'record')
    if (record === undefined) return undefined
    const read = await loads(poster, record.cid, 10)
    return read.ok && read.text.includes(post.postCid) ? one : undefined
  }, 150_000, `B never held a record of ${hosted.address} with the reader's post on its first page`).catch(async (/** @type {unknown} */ error) => {
    await diagnose(`/ipns/${hosted.address}`)
    throw error
  })
  const state = await b.call('seeding', 'state')
  const community = state.communities.find((/** @type {any} */ one) => one.address === hosted.address)
  check('B holds the record, with the reader\'s post on its first page, and counts its size', community?.status === 'holding' && community.bytes > 0 && state.usedBytes === community.bytes, { status: community?.status, bytes: community?.bytes, pins: held.pins.map((/** @type {any} */ pin) => pin.name) })
  const repo = await b.api('repo/stat')
  check('the node\'s repository statistics count the pinned content', repo.RepoSize >= state.usedBytes && state.usedBytes > 0, { repoSize: repo.RepoSize, seeded: state.usedBytes })
  const recordCid = held.pins.find((/** @type {any} */ pin) => pin.name === 'record')?.cid
  const pageCids = held.pins.filter((/** @type {any} */ pin) => pin.name.startsWith('page ')).map((/** @type {any} */ pin) => pin.cid)
  result.cids = { recordCid, pageCids, post: post.postCid, notFound: community?.error ?? null }

  // A goes away. Nothing but B holds the content now.
  a.kill()
  await a.ended()
  await hosted.stop().catch(() => {})
  log('A ended')
  await sleep(2000)

  const third = await freshKubo('third-kubo')
  kubos.push(third)
  await third.ipfs('swarm', 'connect', b.address)
  const peers = (await third.ipfs('swarm', 'peers')).split('\n').filter(Boolean)
  check('the third client dials B and nobody else', peers.length === 1 && peers[0].includes(b.peer), peers)
  const record = await loads(third, recordCid, 90)
  const onFirstPage = record.ok && JSON.stringify(JSON.parse(record.text).posts?.pages ?? {}).includes(post.postCid)
  check('with A gone, the third client loads the record from B, with the reader\'s post on its first page', record.ok && onFirstPage, record.ok ? { bytes: record.text.length, onFirstPage } : record.text)
  for (const cid of pageCids) {
    const page = await loads(third, cid, 60)
    check(`and the page ${cid}`, page.ok, page.ok ? { bytes: page.text.length } : page.text)
  }

  // Turning seeding off frees exactly what it kept.
  const off = await b.call('seeding', 'disable')
  check('turning it off says it is off', off.enabled === false, off)
  await waitFor(async () => (Object.keys(heldOf(b)).length === 0 ? true : undefined), 120_000, 'B still lists what it holds')
  await sleep(3000)
  const fourth = await freshKubo('fourth-kubo')
  kubos.push(fourth)
  await fourth.ipfs('swarm', 'connect', b.address)
  const gone = await loads(fourth, recordCid, 25)
  check('after it is turned off, B no longer serves the record', !gone.ok, gone.ok ? 'the record still loads' : gone.text)
  result.ok = true
} catch (error) {
  result.error = textOf(error)
  log(`FAILED: ${result.error}`)
} finally {
  for (const kubo of kubos) await kubo.stop().catch(() => {})
  for (const worker of workers) worker.kill()
  out.end()
  result.log = logPath
  result.totalMs = Date.now() - started
  const into = argValue('--results')
  if (into !== undefined) { await mkdir(into, { recursive: true }); await copyFile(logPath, join(into, 'seeding-run.log')); await writeFile(join(into, 'seeding-result.json'), JSON.stringify(result, null, 2)) }
  console.log(JSON.stringify(result, null, 2))
  if (!keep && result.ok) await rm(dir, { recursive: true, force: true })
  process.exit(result.ok ? 0 : 1)
}

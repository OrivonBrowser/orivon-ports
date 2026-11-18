// The "Require an Orivon ID" challenge inside the Worker under plain Node (`host.js` over a native build of the IPFS node), on a local fork of
// Ethereum mainnet. A fixture ID is bought on the fork the way the ID site sells one and its `bitsocial` record is set to an author's key; the
// Worker's name resolvers ask the fork and no public node, so the board checks the real registry, the real registrar's resolver and the real
// name resolution of pkc-js and viem. One pkc-js client plays the board owner and the authors. The board is set through the Worker's own
// challenge calls (`apply`), as the dashboard sets it, and every verdict is read from what the board answered and from its published pages.
// Prints one JSON result and exits 0 when every check held, 2 when there is no fork to run on (no anvil, or no public node to fork from).
//
//   IPFS_NODE_BIN=<a native node binary> node orivon-id.js [--keep] [--results <dir>]

import { fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_MESSAGE, NAME, SITE } from '../orivon-id-challenge/index.js'
import { boardClient, textOf, threadsOf } from './board-client.js'
import { buyId, freshAccount, setTextsOfExistingName, startFork } from './orivon-id-fork.js'
import { waitFor } from './scenario.js'

const here = dirname(fileURLToPath(import.meta.url))
const argValue = (/** @type {string} */ name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const keep = process.argv.includes('--keep')
const nodeBin = process.env['IPFS_NODE_BIN']
if (nodeBin === undefined) throw new Error('IPFS_NODE_BIN names a native node binary')

const freePort = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = /** @type {import('node:net').AddressInfo} */ (server.address()); server.close(() => { resolve(port) }) }) })
const dir = await mkdtemp(join(process.env['BM_OUT'] ?? tmpdir(), 'bitsocial-orivon-id-'))
const out = createWriteStream(join(dir, 'run.log'))
const started = Date.now()
const log = (/** @type {string} */ line) => { const text = `[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`; out.write(`${text}\n`); console.error(text) }
const result = /** @type {Record<string, any>} */ ({ when: new Date().toISOString(), ok: false, checks: {}, dir })
const check = (/** @type {string} */ name, /** @type {boolean} */ held, /** @type {unknown} */ detail) => { result.checks[name] = { held, detail }; log(`${held ? 'HELD' : 'FAILED'}: ${name} ${JSON.stringify(detail)}`); if (!held) throw new Error(`check failed: ${name}`) }

/** @type {Awaited<ReturnType<typeof startFork>> | null} */
let chain = null
/** @type {import('node:child_process').ChildProcess | null} */
let host = null
/** @type {Awaited<ReturnType<typeof boardClient>> | null} */
let client = null

async function finish (/** @type {number} */ code) {
  await client?.destroy()
  if (host?.pid !== undefined) { try { process.kill(-host.pid, 'SIGKILL') } catch { /* gone */ } }
  if (chain !== null && 'stop' in chain) await chain.stop()
  out.end()
  result.log = join(dir, 'run.log')
  const into = argValue('--results')
  if (into !== undefined) { await mkdir(into, { recursive: true }); await copyFile(join(dir, 'run.log'), join(into, 'orivon-id-run.log')); await writeFile(join(into, 'orivon-id-result.json'), JSON.stringify(result, null, 2)) }
  console.log(JSON.stringify(result, null, 2))
  if (!keep && code === 0) await rm(dir, { recursive: true, force: true })
  process.exit(code)
}

try {
  chain = await startFork()
  if ('skip' in chain) { result.skipped = chain.skip; log(`no fork: ${chain.skip}`); await finish(2) }
  const fixture = /** @type {{ url: string, nodeUrl: string, block: string }} */ (chain)
  result.forkBlock = fixture.block
  log(`fork of mainnet block ${fixture.block} at ${fixture.url}, reading from ${new URL(fixture.nodeUrl).hostname}`)

  const [rpcPort, gateway, fakeKubo, nodeApi, p2p] = await Promise.all(Array.from({ length: 5 }, freePort))
  const authKey = randomBytes(16).toString('hex')
  const files = join(dir, 'files')
  await mkdir(files, { recursive: true })
  const config = { authKey, files, ports: { rpc: rpcPort, gateway, kubo: fakeKubo, nodeApi, p2p }, origins: [], trace: 'warn' }
  host = fork(join(here, 'host.js'), [], {
    silent: true, detached: true, serialization: 'advanced',
    env: { ...process.env, BITSOCIAL_NODE: JSON.stringify(config), IPFS_NODE_BIN: nodeBin, ETH_RPC_URLS: JSON.stringify([fixture.url]), NODE_LOG_FILE: join(dir, 'node.log'), NODE_ENV: 'production' }
  })
  const messages = /** @type {Array<Record<string, any>>} */ ([])
  for (const stream of [host.stdout, host.stderr]) stream?.on('data', (chunk) => { for (const line of String(chunk).split('\n')) if (line.trim() !== '') out.write(`  worker: ${line.slice(0, 700)}\n`) })
  host.on('message', (/** @type {Record<string, any>} */ message) => { messages.push(message); if (message['type'] !== 'status') log(`the Worker says ${JSON.stringify(message).slice(0, 300)}`) })
  const ready = await waitFor(() => messages.find((message) => message['type'] === 'ready' || message['type'] === 'failed'), 240_000, 'the Worker never said ready')
  if (ready['type'] !== 'ready') throw new Error(`the Worker failed: ${JSON.stringify(ready)}`)
  log('the Worker is ready')

  const call = async (/** @type {string} */ name, /** @type {Record<string, unknown>} */ body = {}) => {
    const answer = await fetch(`http://127.0.0.1:${String(gateway)}/orivon/challenges/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${authKey}` }, body: JSON.stringify(body) })
    return { status: answer.status, body: /** @type {any} */ (await answer.json()) }
  }
  const listed = await call('list')
  const entry = listed.body.challenges.find((/** @type {{ name: string }} */ one) => one.name === NAME)
  check('the list offers the challenge, bundled, with its message as the default of its one option', listed.status === 200 && entry?.source === 'bundled' && entry.optionInputs?.[0]?.option === 'error' && entry.optionInputs[0].default === DEFAULT_MESSAGE && entry.hosts.length === 6, entry)

  client = await boardClient(`ws://127.0.0.1:${String(rpcPort)}/${authKey}`, log)
  const board = await client.createBoard('Orivon ID', false)
  const reader = await client.follow(board.address)
  const applied = await call('apply', { address: board.address, challenges: [{ name: NAME }], expect: [] })
  check('the board takes the preset as the dashboard writes it: the name alone', applied.status === 200 && JSON.stringify(applied.body.challenges) === JSON.stringify([{ name: NAME }]), applied.body)

  // The fixture ID: bought on the fork, its resolver the buyer's own, its `bitsocial` record the key of the author who will post as it.
  const holder = await client.createSigner()
  const stranger = await client.createSigner()
  const label = `bsfixture${randomBytes(3).toString('hex')}`
  const id = await buyId(fixture.url, label, freshAccount(label))
  await id.setRecords({ bitsocial: holder.address })
  log(`fixture ID ${id.name} bought on the fork, its bitsocial record is ${holder.address}`)

  /** One post by `signer`, with the author name `name`. @param {string} title @param {any} signer @param {string | undefined} name */
  const post = (title, signer, name) => client?.tryPost(board.address, { title, content: `${title}, a post to check the board's challenge` }, { signer, ...(name === undefined ? {} : { author: { name } }) })
  /** @param {string} title @param {any} signer @param {string | undefined} name */
  async function verdictOf (title, signer, name) {
    const verdict = await /** @type {NonNullable<ReturnType<typeof post>>} */ (post(title, signer, name))
    log(`${title}: ${verdict.success ? 'accepted' : 'refused'} ${verdict.reason}`)
    return verdict
  }
  /** What the board's verdicts held, by title, for the report. @type {Record<string, any>} */
  const verdicts = {}
  const accepted = []

  const holderPost = await verdictOf('holder', holder, id.name)
  verdicts['holder'] = holderPost
  check('a post by the author whose name is a fixture ID and whose key its record holds is accepted', holderPost.success && holderPost.cid !== undefined, { reason: holderPost.reason, cid: holderPost.cid })
  accepted.push('holder')

  const bsoPost = await verdictOf('holder-bso', holder, `${label}.v1.orivonid.bso`)
  verdicts['holder-bso'] = bsoPost
  check('the same name spelled .bso, the protocol\'s other spelling of .eth, is accepted too', bsoPost.success, { reason: bsoPost.reason })
  accepted.push('holder-bso')

  const anonymous = await verdictOf('anonymous', await client.createSigner(), undefined)
  verdicts['anonymous'] = anonymous
  check('a post with no author name is refused with the message, which links the site', !anonymous.success && anonymous.reason.includes(DEFAULT_MESSAGE) && anonymous.reason.includes(SITE), anonymous.reason)

  // pkc-js's own check of an author's name runs before any challenge (the name must resolve, from a record up to 30 minutes old, to the key that signed),
  // so these three are refused by it with its words, and never reach the challenge.
  const impostor = await verdictOf('impostor', stranger, id.name)
  verdicts['impostor'] = impostor
  check('another key that writes the ID\'s name is refused by pkc-js, whose own check finds the record names another key', !impostor.success && /does not match the publication signer/.test(impostor.reason) && !impostor.reason.includes(DEFAULT_MESSAGE), impostor.reason)

  const unsold = await verdictOf('unsold', await client.createSigner(), `nobody${randomBytes(3).toString('hex')}.v1.orivonid.eth`)
  verdicts['unsold'] = unsold
  check('a name under the registry that nobody holds is refused by pkc-js with its reason', !unsold.success && unsold.reason !== '' && !unsold.reason.includes(DEFAULT_MESSAGE), unsold.reason)

  const unresolvable = []
  for (const [title, name] of /** @type {const} */ ([['orv', `${label}.orv`], ['look-alike', `${label}.v1.orivonid.com`]])) {
    const refused = await verdictOf(title, await client.createSigner(), name)
    verdicts[title] = refused
    unresolvable.push([title, !refused.success && refused.reason !== ''])
  }
  check('a name in a TLD the node has no resolver for (.orv, which only Orivon resolves) is refused', unresolvable.every(([, held]) => held), unresolvable)

  // A name that does resolve to the signer, and is not an ID, is the one the challenge's own shape check is for: ENS's own `resolver.eth`, whose
  // `bitsocial` record the fork is made to hold this author's key.
  const notId = 'resolver.eth'
  const plainSigner = await client.createSigner()
  await setTextsOfExistingName(fixture.url, notId, { bitsocial: plainSigner.address })
  const plain = await verdictOf('plain-ens', plainSigner, notId)
  verdicts['plain-ens'] = plain
  check('a name that resolves to the signer but is not an Orivon ID is refused with the message alone: no "different address", no resolver reason', !plain.success && plain.reason.includes(DEFAULT_MESSAGE) && !/different address|text record|resolvers/.test(plain.reason), plain.reason)

  // The challenge reads the record fresh at each post, and what it reads is what pkc-js's later checks use: when the holder points the record at another
  // key, the old key is refused at once (by the challenge's own read, or by pkc-js's check if its cache had already aged out) and the new key is let in.
  await id.setText('bitsocial', stranger.address)
  const moved = await verdictOf('moved-away', holder, id.name)
  verdicts['moved-away'] = moved
  check('after the ID\'s record names another key, the first key is refused at once, with no wait for a cache to expire', !moved.success && /record holds a different address|does not match the publication signer/.test(moved.reason), moved.reason)
  const movedIn = await verdictOf('moved-in', stranger, id.name)
  verdicts['moved-in'] = movedIn
  check('and the key the record names now is accepted', movedIn.success, movedIn.reason)
  accepted.push('moved-in')

  // The pages are the board's record: what it accepted is there, what it refused is not.
  const cids = Object.fromEntries(accepted.map((title) => [title, verdicts[title].cid]))
  await client.pagesShow(reader, (threads) => Object.values(cids).every((cid) => threads.some((thread) => thread['cid'] === cid)), 240_000, 'the accepted posts are on the board\'s pages')
  const titles = threadsOf(reader).map((thread) => String(thread['title']))
  check('the board\'s pages hold the accepted posts and none that was refused', accepted.every((title) => titles.includes(title)) && ['anonymous', 'impostor', 'unsold', 'plain-ens', 'orv', 'look-alike', 'moved-away'].every((title) => !titles.includes(title)), titles)

  const removed = await call('apply', { address: board.address, challenges: [], expect: [{ name: NAME }] })
  check('the preset comes off again: the board then asks nothing', removed.status === 200 && removed.body.challenges.length === 0, removed.body)
  const open = await verdictOf('after-removal', await client.createSigner(), undefined)
  check('and a post with no name is accepted again', open.success, open.reason)

  result.verdicts = Object.fromEntries(Object.entries(verdicts).map(([title, one]) => [title, { success: one.success, reason: one.reason }]))
  result.ok = true
  await finish(0)
} catch (error) {
  const details = /** @type {any} */ (error)?.details
  result.error = `${textOf(error)}${details === undefined ? '' : ` ${JSON.stringify(details)}`}`
  log(`FAILED: ${result.error}`)
  await finish(1)
}

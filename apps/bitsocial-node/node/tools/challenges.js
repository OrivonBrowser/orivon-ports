// The anti-spam challenges inside the Worker under plain Node (`host.js` over a native build of the IPFS node). One pkc-js client plays
// the board owner and the authors: for each bundled challenge it sets the challenge on a board through `editCommunity`, publishes a
// comment the challenge must refuse and one it must accept, and reads the result from the board's own published pages. The page
// API's list is read first, over the gateway socket, as the dashboard reads it.
//
// The services a challenge calls are local stand-ins (`challenge-services.js`): a chain with a fixture contract for `evm-contract`
// (read-only: no transaction is ever built), the issuer endpoints of `spam-blocker` and `flags`, and an OpenAI-style endpoint for
// `ai-moderation`. A captcha is answered from the answer the library wrote to `CAPTCHA_TAP`. Prints one JSON result and exits 0
// when every check held.
//
//   IPFS_NODE_BIN=<a native node binary> node challenges.js [--only wordfilter,captcha] [--keep] [--results <dir>]

import { fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { boardClient, textOf, threadsOf } from './board-client.js'
import { CONTRACT, startChallengeServices } from './challenge-services.js'
import { waitFor } from './scenario.js'

const here = dirname(fileURLToPath(import.meta.url))
const argValue = (/** @type {string} */ name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const keep = process.argv.includes('--keep')
const only = argValue('--only')?.split(',')
const nodeBin = process.env['IPFS_NODE_BIN']
if (nodeBin === undefined) throw new Error('IPFS_NODE_BIN names a native node binary')

const freePort = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = /** @type {import('node:net').AddressInfo} */ (server.address()); server.close(() => { resolve(port) }) }) })
const dir = await mkdtemp(join(process.env['BM_OUT'] ?? tmpdir(), 'bitsocial-challenges-'))
const out = createWriteStream(join(dir, 'run.log'))
const started = Date.now()
const log = (/** @type {string} */ line) => { const text = `[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`; out.write(`${text}\n`); console.error(text) }

const [rpc, gateway, fakeKubo, nodeApi, p2p] = await Promise.all(Array.from({ length: 5 }, freePort))
const authKey = randomBytes(16).toString('hex')
const files = join(dir, 'files')
await mkdir(files, { recursive: true })
const tap = join(dir, 'captcha-answers.txt')
const config = { authKey, files, ports: { rpc, gateway, kubo: fakeKubo, nodeApi, p2p }, origins: [], trace: 'warn' }
const rich = privateKeyToAccount(generatePrivateKey())
const poor = privateKeyToAccount(generatePrivateKey())
const services = await startChallengeServices({ balances: { [rich.address.toLowerCase()]: 5000n } })

const host = fork(join(here, 'host.js'), [], {
  silent: true, detached: true, serialization: 'advanced',
  env: { ...process.env, BITSOCIAL_NODE: JSON.stringify(config), IPFS_NODE_BIN: nodeBin, CAPTCHA_TAP: tap, NODE_LOG_FILE: join(dir, 'node.log'), NODE_ENV: 'production' }
})
const messages = /** @type {Array<Record<string, any>>} */ ([])
for (const stream of [host.stdout, host.stderr]) stream?.on('data', (chunk) => { for (const line of String(chunk).split('\n')) if (line.trim() !== '') out.write(`  worker: ${line.slice(0, 700)}\n`) })
host.on('message', (/** @type {Record<string, any>} */ message) => { messages.push(message); if (message['type'] !== 'status') log(`the Worker says ${JSON.stringify(message).slice(0, 300)}`) })

const result = /** @type {Record<string, any>} */ ({ when: new Date().toISOString(), ok: false, checks: {}, challenges: {}, dir })
const check = (/** @type {string} */ name, /** @type {boolean} */ held, /** @type {unknown} */ detail) => { result.checks[name] = { held, detail }; log(`${held ? 'HELD' : 'FAILED'}: ${name} ${JSON.stringify(detail)}`); if (!held) throw new Error(`check failed: ${name}`) }
const rpcUrl = `ws://127.0.0.1:${rpc}/${authKey}`
const lastAnswer = () => readFileSync(tap, 'utf8').trim().split('\n').at(-1) ?? ''
/** @type {Awaited<ReturnType<typeof boardClient>> | null} */
let client = null

/** The wallet claim of an author, signed as the evm-contract challenge checks it. @param {typeof rich} account @param {{ address: string }} signer */
async function walletOf (account, signer) {
  const timestamp = Math.floor(Date.now() / 1000)
  const message = JSON.stringify({ domainSeparator: 'plebbit-author-wallet', authorAddress: signer.address, timestamp })
  return { eth: { address: account.address, timestamp, signature: { signature: await account.signMessage({ message }), type: 'eip191' } } }
}

const WORDS = [{ src: 'cloud', dst: 'butt' }]
const TAP_ANSWER = async () => [lastAnswer()]
const NAMES = {
  wordfilter: '@bitsocial/wordfilter-challenge', base64: '@bitsocial/base64-challenge', captcha: '@bitsocial/captcha-canvas-challenge', voucher: '@bitsocial/voucher-challenge',
  r9k: '@bitsocial/r9k-challenge', flags: '@bitsocial/flags-challenge', spam: '@bitsocial/spam-blocker-challenge', evm: '@bitsocial/evm-contract-challenge', ai: '@bitsocial/ai-moderation-challenge'
}

/** Each case: the challenge as a board's settings name it, and what to publish. `refuse` and `accept` are lists of attempts, run in order. */
const cases = /** @type {Array<{ id: string, label: string, setting: () => Record<string, unknown>, refuse: () => Array<Record<string, any>>, accept: () => Array<Record<string, any>> }>} */ ([
  {
    id: 'wordfilter', label: 'wordfilter', setting: () => ({ name: NAMES.wordfilter, options: { 'wordfilter/v1/rules': JSON.stringify(WORDS) }, publicOptions: ['wordfilter/v1/rules'] }),
    refuse: () => [{ fields: { title: 'wordfilter refused', content: 'a cloud over the board' }, reason: /replaces certain words/ }],
    accept: () => [{ fields: { title: 'wordfilter accepted', content: 'a butt over the board' } }]
  },
  {
    id: 'base64', label: 'base64', setting: () => ({ name: NAMES.base64, options: {} }),
    refuse: () => [{ fields: { title: 'base64 refused', content: `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUg'.repeat(40)}` }, reason: /base64 data/ }],
    accept: () => [{ fields: { title: 'base64 accepted', content: 'a link instead of an image: https://example.org/a.png' } }]
  },
  {
    id: 'captcha', label: 'captcha-canvas', setting: () => ({ name: NAMES.captcha, options: { characters: '4', width: '200', height: '80' } }),
    refuse: () => [{ fields: { title: 'captcha refused', content: 'answered wrong' }, answers: ['definitely-not'], reason: /Wrong captcha/, image: [200, 80] }],
    accept: () => [{ fields: { title: 'captcha accepted', content: 'answered right' }, answers: TAP_ANSWER }]
  },
  {
    id: 'voucher', label: 'voucher', setting: () => ({ name: NAMES.voucher, options: { question: 'Your voucher?', vouchers: 'VOUCHER-ALPHA,VOUCHER-BETA' } }),
    refuse: () => [{ fields: { title: 'voucher refused', content: 'a voucher nobody issued' }, answers: ['VOUCHER-NOPE'], reason: /Invalid voucher/ }],
    accept: () => [{ fields: { title: 'voucher accepted', content: 'a voucher that is issued' }, answers: ['VOUCHER-ALPHA'] }]
  },
  {
    id: 'r9k', label: 'r9k', setting: () => ({ name: NAMES.r9k, options: { statePath: join(dir, 'r9k-state.json') } }),
    refuse: () => [{ fields: { title: 'r9k original', content: 'an original sentence nobody has written before' }, expect: true }, { fields: { title: 'r9k original', content: 'an original sentence nobody has written before' }, reason: /Exact repost/ }],
    accept: () => [{ fields: { title: 'r9k another', content: 'a second sentence that is also quite new' } }]
  },
  {
    id: 'flags', label: 'flags (a flag is required)', setting: () => ({ name: NAMES.flags, options: { requireFlag: 'true', allowedFlags: 'pony' } }),
    refuse: () => [{ fields: { title: 'flags refused', content: 'no flag was asked for' }, reason: /flag is required/i }],
    accept: () => [{ fields: { title: 'flags accepted', content: 'a pony flag was picked', challengeRequest: { challengeAnswers: ['bitsocial-flags:5chan:flag:pony:twi'] } } }]
  },
  {
    id: 'flags-country', label: 'flags (a country flag, checked by the issuer)', setting: () => ({ name: NAMES.flags, options: { serviceUrl: `${services.url}/flags/api/v1`, allowedFlags: 'country' } }),
    refuse: () => [{ fields: { title: 'country refused', content: 'the issuer says no', challengeRequest: { challengeAnswers: ['bitsocial-flags:5chan:flag:country:it'] } }, answers: ['done'], reason: /not completed|verification failed/i, solved: false }],
    accept: () => [{ fields: { title: 'country accepted', content: 'the issuer says yes', challengeRequest: { challengeAnswers: ['bitsocial-flags:5chan:flag:country:it'] } }, answers: ['done'], solved: true }]
  },
  {
    id: 'spam', label: 'spam-blocker', setting: () => ({ name: NAMES.spam, options: { serverUrl: `${services.url}/spam/api/v1` } }),
    refuse: () => [{ fields: { title: 'spam refused', content: 'the session was not solved' }, answers: ['done'], reason: /not completed|failed/i, solved: false }],
    accept: () => [{ fields: { title: 'spam accepted', content: 'the session was solved' }, answers: ['done'], solved: true }]
  },
  {
    id: 'evm', label: 'evm-contract (fixture chain)', setting: () => ({ name: NAMES.evm, options: { chainTicker: 'eth', rpcUrls: `${services.url}/chain`, address: CONTRACT, condition: '>1000', abi: JSON.stringify({ constant: true, inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' }) } }),
    refuse: () => [{ fields: { title: 'evm refused (no wallet)', content: 'no wallet at all' }, reason: /failed all EVM challenges/ }, { fields: { title: 'evm refused (empty wallet)', content: 'a wallet with no tokens' }, wallet: 'poor', reason: /failed all EVM challenges/ }],
    accept: () => [{ fields: { title: 'evm accepted', content: 'a wallet with 5000 tokens' }, wallet: 'rich' }]
  },
  {
    id: 'ai', label: 'ai-moderation (stand-in model)', setting: () => ({ name: NAMES.ai, options: { apiUrl: `${services.url}/ai/v1/responses`, cachePath: '', auditLogPath: '', prompt: 'Review a publication that holds a forbidden word; allow the rest.' } }),
    refuse: () => [{ fields: { title: 'ai refused', content: 'a FORBIDDEN thing to say' }, reason: /forbidden word/ }],
    accept: () => [{ fields: { title: 'ai accepted', content: 'a kind thing to say' } }]
  }
])

/**
 * A board's settings must give every option the challenge marks `required`; a page builds them from the list, a default where the owner chose none.
 * @param {Record<string, any>} setting @param {Array<{ name: string, optionInputs: Array<{ option: string, required?: boolean, default?: string }> }>} listed
 */
function withRequiredDefaults (setting, listed) {
  const inputs = listed.find((one) => one.name === setting['name'])?.optionInputs ?? []
  const options = { ...setting['options'] }
  for (const input of inputs) if (input.required === true && options[input.option] === undefined) options[input.option] = input.default ?? ''
  return { ...setting, options }
}

/** Publishes one attempt of a case and checks the board's answer. @param {Record<string, any>} one @param {boolean} accepted @param {Awaited<ReturnType<typeof boardClient>>} players @param {string} address */
async function play (one, accepted, players, address) {
  const signer = await players.createSigner()
  if (one['solved'] !== undefined) services.state.solved = one['solved']
  const author = one['wallet'] === undefined ? {} : { address: signer.address, wallets: await walletOf(one['wallet'] === 'rich' ? rich : poor, signer) }
  const verdict = await players.tryPost(address, one['fields'], { signer, author, ...(one['answers'] === undefined ? {} : { answers: one['answers'] }) })
  const wanted = accepted || one['expect'] === true
  return { verdict, wanted, ok: verdict.success === wanted && (wanted || one['reason'] === undefined || one['reason'].test(verdict.reason)), one }
}

try {
  const ready = await waitFor(() => messages.find((message) => message['type'] === 'ready' || message['type'] === 'failed'), 240_000, 'the Worker never said ready')
  if (ready['type'] !== 'ready') throw new Error(`the Worker failed: ${JSON.stringify(ready)}`)
  log('the Worker is ready')

  const answer = await fetch(`http://127.0.0.1:${gateway}/orivon/challenges/list`, { method: 'POST', headers: { Authorization: `Bearer ${authKey}` }, body: '{}' })
  const listed = /** @type {{ challenges: any[], unavailable: any[] }} */ (await answer.json())
  const listedNames = listed.challenges.map((/** @type {{ name: string }} */ one) => one.name)
  check('the list names every bundled challenge, with its schema', answer.ok && Object.values(NAMES).every((name) => listedNames.includes(name)) && listed.challenges.filter((/** @type {any} */ one) => one.source === 'bundled').every((/** @type {any} */ one) => one.optionInputs.length > 0 && one.version !== null && one.licence !== null), listed.challenges.map((/** @type {any} */ one) => [one.name, one.version, one.optionInputs.length]))
  check('the list says what it left out and why, and a wrong key gets nothing', listed.unavailable.some((/** @type {any} */ one) => one.name === '@bitsocial/mintpass-challenge' && /native module/.test(one.reason)) && (await fetch(`http://127.0.0.1:${gateway}/orivon/challenges/list`, { method: 'POST', headers: { Authorization: 'Bearer nope' } })).status === 401, listed.unavailable)

  client = await boardClient(rpcUrl, log)
  const board = await client.createBoard('Challenges', false)
  const reader = await client.follow(board.address)
  const community = /** @type {any} */ (board.community)

  for (const one of cases.filter((entry) => only === undefined || only.includes(entry.id))) {
    log(`-- ${one.label}`)
    const setting = withRequiredDefaults(one.setting(), listed.challenges)
    await community.edit({ settings: { ...community.settings, challenges: [setting] } })
    await waitFor(() => (community.settings?.challenges?.[0]?.name === setting['name'] ? true : undefined), 60_000, `${one.id}: the settings edit did not show`)
    const outcome = /** @type {Record<string, any>} */ ({ refused: [], accepted: [] })
    result.challenges[one.id] = outcome
    for (const kind of /** @type {const} */ (['refuse', 'accept'])) {
      for (const attempt of one[kind]()) {
        const played = await play(attempt, kind === 'accept', client, board.address)
        const shown = { title: attempt.fields.title, success: played.verdict.success, reason: played.verdict.reason, ...(played.verdict.cid === undefined ? {} : { cid: played.verdict.cid }), challenges: played.verdict.asked.flat().map((/** @type {{ type: string }} */ asked) => asked.type) }
        outcome[played.wanted ? 'accepted' : 'refused'].push(shown)
        check(`${one.id}: ${String(attempt.fields.title)} is ${played.wanted ? 'accepted' : 'refused'}`, played.ok, shown)
        if (attempt.image !== undefined) {
          const image = played.verdict.asked.flat().find((/** @type {{ type: string }} */ asked) => asked.type === 'image/png')
          const png = image === undefined ? undefined : PNG.sync.read(Buffer.from(image.challenge, 'base64'))
          check(`${one.id}: the board asked for a PNG of the size it was set to`, png?.width === attempt.image[0] && png?.height === attempt.image[1], png === undefined ? 'no image asked' : [png.width, png.height])
        }
      }
    }
    // The pages are the board's record: what it accepted is there, what it refused is not.
    const accepted = outcome['accepted'].filter((/** @type {{ cid?: string }} */ entry) => entry.cid !== undefined)
    await client.pagesShow(reader, (threads) => accepted.every((/** @type {{ cid: string }} */ entry) => threads.some((thread) => thread['cid'] === entry.cid)), 240_000, `${one.id}: the accepted threads are on the board's pages`)
    const titles = threadsOf(reader).map((thread) => String(thread['title']))
    check(`${one.id}: the board's pages hold what it accepted and no refused thread`, accepted.every((/** @type {{ title: string }} */ entry) => titles.includes(entry.title)) && outcome['refused'].every((/** @type {{ title: string }} */ entry) => titles.filter((title) => title === entry.title).length === accepted.filter((/** @type {{ title: string }} */ one) => one.title === entry.title).length), { accepted: accepted.map((/** @type {{ title: string }} */ entry) => entry.title), refused: outcome['refused'].map((/** @type {{ title: string }} */ entry) => entry.title) })
  }
  result.services = services.requests
  check('the services were reached only as set: the stand-ins answered every call a challenge made', only !== undefined || (services.requests.some((request) => request['service'] === 'chain') && services.requests.some((request) => request['service'] === 'spam' && request['signedWith'] === '32-byte key') && services.requests.some((request) => request['service'] === 'flags') && services.requests.some((request) => request['service'] === 'ai')), services.requests.map((request) => `${String(request['service'])} ${JSON.stringify(request['methods'] ?? request['signedWith'] ?? request['model'])}`))
  result.ok = true
} catch (error) {
  const details = /** @type {any} */ (error)?.details
  result.error = `${textOf(error)}${details === undefined ? '' : ` ${JSON.stringify(details)}`}`
  log(`FAILED: ${result.error}`)
} finally {
  await client?.destroy()
  if (host.pid !== undefined) { try { process.kill(-host.pid, 'SIGKILL') } catch { /* gone */ } }
  await services.close()
  out.end()
  result.log = join(dir, 'run.log')
  const into = argValue('--results')
  if (into !== undefined) { await mkdir(into, { recursive: true }); const { copyFile, writeFile } = await import('node:fs/promises'); await copyFile(join(dir, 'run.log'), join(into, 'challenges-run.log')); await writeFile(join(into, 'challenges-result.json'), JSON.stringify(result, null, 2)) }
  console.log(JSON.stringify(result, null, 2))
  if (!keep && result.ok) await rm(dir, { recursive: true, force: true })
  process.exit(result.ok ? 0 : 1)
}

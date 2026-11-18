// The anti-spam challenges the node runs, by the name a board's `settings.challenges[i].name` uses: the package name, as
// `bitsocial challenge install <package>` registers it on a desktop node. `BUNDLED` are the packages built into the Worker and
// `EXCLUDED` the ones this build cannot run, with the reason. pkc-js looks a name up in `PKC.challenges`, so `registerChallenges`
// puts each factory there before the RPC server starts, and `describeChallenges` is what a page reads to offer them. The
// version and licence are written here and checked against the installed package and `package.json` by node/test/challenges.test.ts.

import aiModeration from '@bitsocial/ai-moderation-challenge'
import base64 from '@bitsocial/base64-challenge'
import captchaCanvas from '@bitsocial/captcha-canvas-challenge'
import evmContract from '@bitsocial/evm-contract-challenge'
import flags from '@bitsocial/flags-challenge'
import r9k from '@bitsocial/r9k-challenge'
import spamBlocker from '@bitsocial/spam-blocker-challenge'
import voucher from '@bitsocial/voucher-challenge'
import wordfilter from '@bitsocial/wordfilter-challenge'
import orivonId, { NAME as ORIVON_ID } from '../orivon-id-challenge/index.js'
import { ETH_RPC_URLS } from './eth-providers.js'

const GPL = 'GPL-3.0-or-later'

/**
 * @typedef {object} Bundled
 * @property {string} name the package name, the registered name
 * @property {string} version
 * @property {string} licence
 * @property {(options: { challengeSettings: Record<string, unknown> }) => Record<string, any>} factory
 * @property {string[]} hosts the hosts the challenge calls with its default options (for evm-contract, the server its own copy of viem names for Ethereum, which a test checks; the dashboard says the browser's light client instead when the node reads Ethereum through it)
 * @property {string[]} hostOptions the options that name another host (or, for evm-contract, the one it reads a chain from)
 * @property {boolean} [viaNames] the hosts are the Ethereum providers of the node's name resolvers (the Orivon ID challenge reads a name's record through them), so the dashboard says the browser's light client instead while the node reads Ethereum through it
 * @property {string} asks what a poster is asked, in a sentence a person reads (a challenge that checks without asking says so)
 * @property {Record<string, string>} [fileOptions] the options that name a file the challenge writes, each with a file name for the app's own folder
 * @property {string} [note] what a board owner has to know to set it
 */

/** @type {readonly Readonly<Bundled>[]} */
export const BUNDLED = Object.freeze([
  { name: '@bitsocial/ai-moderation-challenge', version: '0.5.1', licence: GPL, factory: aiModeration, hosts: ['api.openai.com', 'api.typesafe.ai'], hostOptions: ['apiUrl', 'triageApiUrl', 'jevApiUrl', 'promptUrl'], asks: 'Nothing to answer: each publication is sent to an AI model, which can refuse it.', note: 'sends each publication to the API it is set to; its cache and audit log are files, set `cachePath` and `auditLogPath` under this app\'s files' },
  { name: '@bitsocial/base64-challenge', version: '0.1.1', licence: GPL, factory: base64, hosts: [], hostOptions: [], asks: 'Nothing to answer: a publication that embeds base64 data, such as a pasted picture, is refused.' },
  { name: '@bitsocial/captcha-canvas-challenge', version: '0.1.5', licence: GPL, factory: captchaCanvas, hosts: [], hostOptions: [], asks: 'Shows a picture of letters and digits to type in.', note: 'draws its image with a pure-JavaScript canvas in one typeface, not with skia-canvas' },
  { name: '@bitsocial/evm-contract-challenge', version: '0.1.7', licence: GPL, factory: evmContract, hosts: ['ethereum.reth.rs'], hostOptions: ['rpcUrls'], asks: 'The poster\'s wallet must pass a test on a smart contract, such as holding a token.', note: 'reads the chain from `rpcUrls`, or, with none, on Ethereum through the browser\'s light client when it has one and otherwise from the server its own copy of viem names for the chain (ethereum.reth.rs for eth), not through pkc-js\'s chain providers; it reads an author\'s .eth or .bso name on Ethereum whatever chain the board is on, from `rpcUrls` when the board is on Ethereum and otherwise through the browser\'s light client when it has one and from ethereum.reth.rs when it has not; it only reads, never sends a transaction' },
  { name: '@bitsocial/flags-challenge', version: '0.1.3', licence: GPL, factory: flags, hosts: ['flags.5chan.app'], hostOptions: ['serviceUrl'], asks: 'Lets a poster pick a flag to show: a country flag is checked with the flag service, and the board can require one.' },
  { name: '@bitsocial/r9k-challenge', version: '0.1.1', licence: GPL, factory: r9k, hosts: [], hostOptions: [], asks: 'Nothing to answer: a publication that repeats text already posted is refused, and a repeat can earn a temporary ban.', fileOptions: { statePath: 'r9k-state.json' }, note: 'keeps what it has seen in a file: set `statePath` under this app\'s files' },
  { name: '@bitsocial/spam-blocker-challenge', version: '0.1.7', licence: GPL, factory: spamBlocker, hosts: ['spamblocker.bitsocial.net'], hostOptions: ['serverUrl'], asks: 'Sends each publication to a spam-scoring service, and may show the poster a page to solve.' },
  { name: '@bitsocial/voucher-challenge', version: '0.1.4', licence: GPL, factory: voucher, hosts: [], hostOptions: [], asks: 'Asks for a voucher code, which works for one author only.', note: 'keeps each board\'s redeemed vouchers in the board\'s own data folder' },
  { name: '@bitsocial/wordfilter-challenge', version: '0.3.1', licence: GPL, factory: wordfilter, hosts: [], hostOptions: [], asks: 'Nothing to answer: a publication that still holds a filtered word is refused, and an app that follows the word-replacement contract replaces the word before it signs.', note: 'rejects a publication that still holds a filtered word; a client that follows the wordfilter/v1 contract (5chan does) replaces the word before it signs' }
])

/** The Ethereum providers the node's name resolvers ask: what the Orivon ID challenge reads a name's record through. */
const ETHEREUM_HOSTS = ETH_RPC_URLS.map((url) => new URL(url).hostname)

/**
 * The challenges that are ours, listed and registered beside the packages. Version and licence are those of the package's own `package.json`
 * (`node/orivon-id-challenge/`), which a test checks.
 * @type {readonly Readonly<Bundled>[]}
 */
export const OWN = Object.freeze([
  {
    name: ORIVON_ID, version: '0.1.0', licence: 'AGPL-3.0-only', factory: orivonId, hosts: ETHEREUM_HOSTS, hostOptions: [], viaNames: true,
    asks: 'The poster\'s author name must be an Orivon ID: a name such as alice.v1.orivonid.eth whose "bitsocial" record holds the author\'s address, which the node checks on Ethereum. IDs are bought at id.orivonstack.eth; if that site has not opened yet, no author has one and this board refuses every post.',
    note: 'runs on this node only: a board that names it needs a node that has it. It reads the name\'s record through the node\'s `.eth` and `.bso` name resolvers, which no option of the challenge changes: through the browser\'s light client when the node reads Ethereum through it, otherwise from their Ethereum providers'
  }
])

/** Every challenge the Worker registers and lists: the packages, then the ones that are ours. */
export const ALL = Object.freeze([...BUNDLED, ...OWN])

/**
 * @typedef {object} Excluded
 * @property {string} name
 * @property {string} version the version looked at
 * @property {string} licence
 * @property {string} reason what a page says
 */

/** @type {readonly Readonly<Excluded>[]} */
export const EXCLUDED = Object.freeze([
  { name: '@bitsocial/mintpass-challenge', version: '1.5.0', licence: GPL, reason: 'needs a native module (sqlite3, through @keyv/sqlite, for its cooldowns and bindings); not available in this build' }
])

/**
 * Puts each bundled challenge in `registry` under its package name; a name already there is replaced, as an install does, and
 * nothing else is touched.
 * @param {Record<string, unknown>} registry `PKC.challenges`
 * @param {readonly Bundled[]} [bundled] the packages and ours (`ALL`)
 * @param {{ ethereumUrl?: string }} [reading] `ethereumUrl`: the node's own endpoint for Ethereum, which the evm-contract challenge reads from when its owner named no server
 * @returns {string[]} the names registered
 */
export function registerChallenges (registry, bundled = ALL, { ethereumUrl } = {}) {
  for (const one of bundled) registry[one.name] = ethereumUrl !== undefined && one.name === EVM_CONTRACT ? readingFrom(one.factory, ethereumUrl) : one.factory
  return bundled.map((one) => one.name)
}

const EVM_CONTRACT = '@bitsocial/evm-contract-challenge'

/**
 * The evm-contract challenge with a server for Ethereum: it reads Ethereum with its own copy of viem, whose default server is a public one that differs from copy to copy,
 * so a board whose owner named no server (and no other chain) is read from `ethereumUrl`, the node's endpoint, which asks the browser's light client first. A server the owner
 * named, and any chain but Ethereum, are left as they are. The board's settings are never changed: only the options this challenge is asked with.
 * @param {(settings: any) => any} factory @param {string} ethereumUrl
 */
export function readingFrom (factory, ethereumUrl) {
  return (/** @type {any} */ given) => {
    const challenge = factory(given)
    const getChallenge = challenge.getChallenge
    if (typeof getChallenge !== 'function') return challenge
    return {
      ...challenge,
      getChallenge: (/** @type {any} */ args) => {
        const options = args?.challengeSettings?.options ?? {}
        const ticker = String(options.chainTicker ?? 'eth').trim().toLowerCase()
        const named = typeof options.rpcUrls === 'string' && options.rpcUrls.trim() !== ''
        if (ticker !== 'eth' && ticker !== '') return getChallenge.call(challenge, args)
        if (named) return getChallenge.call(challenge, args)
        return getChallenge.call(challenge, { ...args, challengeSettings: { ...args.challengeSettings, options: { ...options, rpcUrls: ethereumUrl } } })
      }
    }
  }
}

/** What a factory says of itself, without the functions the page cannot receive. @param {Record<string, any>} made */
const publicFields = (made) => ({
  description: typeof made['description'] === 'string' ? made['description'] : '',
  type: typeof made['type'] === 'string' ? made['type'] : '',
  optionInputs: Array.isArray(made['optionInputs']) ? JSON.parse(JSON.stringify(made['optionInputs'])) : [],
  ...(typeof made['caseInsensitive'] === 'boolean' ? { caseInsensitive: made['caseInsensitive'] } : {})
})

/** @param {unknown} factory */
function ask (factory) {
  try { return { made: /** @type {Record<string, any>} */ ((/** @type {any} */ (factory))({ challengeSettings: {} })) } } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
}

/**
 * @typedef {object} Described what a page reads of one challenge
 * @property {string} name the name a board's settings use
 * @property {'pkc-js' | 'bundled'} source
 * @property {string | null} version
 * @property {string | null} licence
 * @property {string} description the challenge's own description
 * @property {string} type
 * @property {Array<{ option: string, label?: string, description?: string, default?: string, placeholder?: string, required?: boolean }>} optionInputs the options it declares, in its order
 * @property {boolean} [caseInsensitive]
 * @property {string} [error] why the factory could not be asked
 * @property {string} [asks] what a poster is asked, in a sentence (a bundled challenge)
 * @property {string[]} [hosts] the hosts it calls with its default options
 * @property {string[]} [hostOptions] the options that name another host
 * @property {boolean} [viaNames] the hosts are the node's name resolvers' Ethereum providers, which the browser's light client replaces while the node reads through it
 * @property {string} [note]
 * @property {Record<string, string>} [suggested] a file for each option that names one, under the app's files
 */

/**
 * The challenges a board's settings can name, for a page: each registered one with its description and the schema of its options,
 * and each one this build left out with why. A challenge that pkc-js has built in has no version or licence of this Worker's.
 * @param {Record<string, unknown>} registry `PKC.challenges`, after `registerChallenges`
 * @param {{ bundled?: readonly Bundled[], excluded?: readonly Excluded[], filesDir?: string }} [lists] `filesDir` is the app's own folder, where the
 *   options that name a file are told to put it
 * @returns {{ challenges: Described[], unavailable: Array<{ name: string, version: string, licence: string, reason: string }> }}
 */
export function describeChallenges (registry, { bundled = ALL, excluded = EXCLUDED, filesDir } = {}) {
  const ours = new Map(bundled.map((one) => [one.name, one]))
  const builtins = Object.keys(registry).filter((name) => !ours.has(name)).map((name) => {
    const { made, error } = ask(registry[name])
    return { name, source: /** @type {const} */ ('pkc-js'), version: null, licence: null, ...(made === undefined ? { description: '', type: '', optionInputs: [], error } : publicFields(made)) }
  })
  const registered = [...ours.values()].filter((one) => Object.hasOwn(registry, one.name)).sort((a, b) => a.name.localeCompare(b.name)).map((one) => {
    const { made, error } = ask(registry[one.name])
    return {
      name: one.name, source: /** @type {const} */ ('bundled'), version: one.version, licence: one.licence,
      ...(made === undefined ? { description: '', type: '', optionInputs: [], error } : publicFields(made)),
      asks: one.asks, hosts: [...one.hosts], hostOptions: [...one.hostOptions], ...(one.viaNames === true ? { viaNames: true } : {}), ...(one.note === undefined ? {} : { note: one.note }),
      ...(filesDir === undefined || one.fileOptions === undefined ? {} : { suggested: Object.fromEntries(Object.entries(one.fileOptions).map(([option, file]) => [option, `${filesDir}/challenges/${file}`])) })
    }
  })
  const missing = [...ours.values()].filter((one) => !Object.hasOwn(registry, one.name)).map((one) => ({ name: one.name, version: one.version, licence: one.licence, reason: 'bundled, but not registered in this Worker' }))
  return {
    challenges: [...builtins, ...registered],
    unavailable: [...excluded.map((one) => ({ name: one.name, version: one.version, licence: one.licence, reason: one.reason })), ...missing]
  }
}

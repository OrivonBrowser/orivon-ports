// What the challenges section says about a challenge in a person's words: its short name, what it asks of a poster, and the one host it reaches.
// The host line is what a board owner reads before adding a challenge, because a web server a challenge calls is a Level 1 (Web2) connection for
// the Web3 Score. A challenge that reads a chain with no server named says where the node reads it from now (`hostLine`).

import { presetOf } from './challenge-presets.js'

/** @param {string} name the package name `bitsocial challenge install` registers, or any other name or path */
export const shortName = (name) => presetOf(name)?.short ?? name.replace(/^@bitsocial\//, '').replace(/-challenge$/, '')

/** What a poster is asked: the node's own sentence for a bundled challenge, otherwise the challenge's own description. @param {{ asks?: string, description?: string } | undefined} info */
export const asksOf = (info) => info?.asks ?? info?.description ?? ''

/**
 * A third-party text with the app's word for what a node hosts, so an option's help never says "community" in an app that says "board". An
 * identifier such as `author.community.flairs` is left as it is.
 * @param {string} text @param {import('./terms.js').Term} term
 */
export function inTerm (text, term) {
  return text.replace(/(?<![\w./-])(communit(?:y|ies)|boards?)(?![\w./-])/gi, (found) => {
    const plural = /ies$|s$/i.test(found)
    const word = plural ? term.boards : term.board
    return found[0] === found[0]?.toUpperCase() ? word.charAt(0).toUpperCase() + word.slice(1) : word
  })
}

/** @param {string} text @returns {string | null} the host of one URL, written with or without its scheme */
function hostOf (text) {
  for (const candidate of [text, `https://${text}`]) {
    try { const host = new URL(candidate).hostname; if (host !== '') return host } catch { /* the next spelling */ }
  }
  return null
}

/** @param {string[]} items */
const joined = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`)

const LEVEL_ONE = 'an ordinary web server, which counts as a Level 1 (Web2) connection for the Web3 Score.'
const CHOOSE = '(name RPC URLs to choose others)'

/**
 * What the node reports of the way it reads Ethereum (`ethereum-words.js`), as a challenge that reads it says where it connects, or null when the node reads Ethereum
 * as the challenge's own library does: a browser with no light client for apps, a node with no internet, or a node that does not say.
 * @param {import('./ethereum-words.js').Reads | null | undefined} reads @returns {string | null}
 */
function lightClientLine (reads) {
  switch (reads?.path) {
    case 'light-client': return `Connects to your browser's light client for Ethereum by default ${CHOOSE}: it checks each answer, and a public server is asked only for what it cannot answer.`
    case 'asking': return `Connects to public Ethereum servers by default until you answer your browser's question about its light client, which then reads Ethereum instead ${CHOOSE}: ${LEVEL_ONE}`
    case 'public': return reads.why === 'unsupported' ? null : `Connects to public Ethereum servers by default, because your browser's light client is off, was not allowed for this app or did not answer ${CHOOSE}: ${LEVEL_ONE}`
    default: return null
  }
}

/** The chain a challenge's options name, as the Worker reads it (`readingFrom`): Ethereum when none is set. @param {Record<string, string>} options */
const tickerOf = (options) => (options['chainTicker'] ?? 'eth').trim().toLowerCase()

/**
 * The sentence for the other read of a challenge on a chain but Ethereum: an author's .eth or .bso name. The challenge looks it up on Ethereum with a client of its own,
 * whatever the board's `rpcUrls` name, from the server its library names for Ethereum (the challenge's host); a browser with a light client for apps answers that server's
 * address from it instead (`ensRoute` in the node's `ethereum-reads.js`), and the public servers are asked only for what it cannot answer.
 * @param {import('./ethereum-words.js').Reads | null | undefined} reads @param {string} host the server the challenge's library names for Ethereum
 */
function authorNameSentence (reads, host) {
  const name = 'An author\'s .eth or .bso name is read'
  if (reads?.path === 'light-client') return `${name} through your browser's light client, which checks each answer and asks a public server only for what it cannot answer.`
  if (reads?.path === 'asking') return `${name} from public Ethereum servers until you answer your browser's question about its light client, which then reads it instead (Level 1 too).`
  if (reads?.path === 'public' && reads.why !== 'unsupported') return `${name} from public Ethereum servers, because your browser's light client is off, was not allowed for this app or did not answer (Level 1 too).`
  return `${name} from ${host} (Level 1 too).`
}

/**
 * One line naming the host a challenge reaches with these options, or '' for a challenge that reaches none. The options that name another host
 * replace the defaults. The `rpcUrls` of a chain challenge, when empty, leave the endpoint the node chooses: on Ethereum the browser's light client
 * when the node reads through it (`reads`, what the node reports), otherwise the server the challenge's own library names; on another chain, that library's.
 * A challenge whose hosts are the node's own Ethereum providers (`viaNames`: the Orivon ID challenge reads a name's record through them) names the browser's light client while
 * the node reads through it, and the providers otherwise. A chain challenge on another chain than Ethereum says its two reads: the contract, and an author's name.
 * @param {{ hosts?: string[], hostOptions?: string[], viaNames?: boolean } | undefined} info @param {Record<string, string>} options
 * @param {import('./ethereum-words.js').Reads | null} [reads]
 */
export function hostLine (info, options, reads) {
  const hosts = info?.hosts ?? []
  if (hosts.length === 0) return ''
  if (info?.viaNames === true && reads?.path === 'light-client') return `Connects to your browser's light client for Ethereum: it checks each answer, and a public server is asked only for what it cannot answer.`
  const named = (info?.hostOptions ?? []).flatMap((option) => (options[option] ?? '').split(/[\s,]+/).filter((one) => one !== ''))
  const chosen = [...new Set(named.map(hostOf).filter((host) => host !== null))]
  const chain = (info?.hostOptions ?? []).includes('rpcUrls')
  const ticker = tickerOf(options)
  const elsewhere = chain && ticker !== 'eth' && ticker !== ''
  const names = elsewhere ? ` ${authorNameSentence(reads, joined(hosts))}` : ''
  if (chosen.length > 0) return `Connects to ${joined(chosen)}: ${LEVEL_ONE}${names}`
  if (chain && (options['rpcUrls'] ?? '').trim() === '') {
    if (elsewhere) return `Connects to the server its chain library names for ${ticker} by default ${CHOOSE}: ${LEVEL_ONE}${names}`
    const light = lightClientLine(reads)
    if (light !== null) return light
  }
  return `Connects to ${joined(hosts)}${chain ? ` by default ${CHOOSE}` : ''}: ${LEVEL_ONE}`
}

// Where the lists are, how a directory is read from them, and the issue a board owner sends to get a board listed: its address on
// GitHub, its text (what is asked, what the board misses, the signed message) and the one line that checks the signature.
// GitHub has no address that fills in an edit of a file that exists, so the request is an issue with the entry in its body, as
// seedit's own "propose a community" link does it.

import { requirementsOf, wordsOf } from './listing-requirements.js'

export const LISTS_REPO = 'https://github.com/bitsocialnet/lists'
export const LISTS_RAW = 'https://raw.githubusercontent.com/bitsocialnet/lists/master/'

/** The directory families of the lists: where each keeps its files and defaults, and what the entries of a file are called. */
export const FAMILIES = Object.freeze({
  '5chan': { folder: '5chan-directories', defaults: '5chan-directories/5chan-directories-defaults.json', entries: 'boards', what: 'board' },
  seedit: { folder: 'seedit-directories', defaults: 'seedit-directories/seedit-directories-defaults.json', entries: 'communities', what: 'community' }
})

/** @typedef {keyof typeof FAMILIES} Family */
/** @typedef {{ code: string, title: string, file: string, requirements: import('./listing-requirements.js').Requirement[] }} Directory */
/** @typedef {{ file: string, entry: Record<string, unknown>, message: string, signature: string, publicKey: string }} Signed */

/** A code the lists use: lower-case letters and digits, joined by hyphens. */
const CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** @param {Family} family @param {string} code */
export const fileOf = (family, code) => `${FAMILIES[family].folder}/${family}-${code}-directory.json`

/** Where a person reads a file of the lists. @param {string} file */
export const blobUrl = (file) => `${LISTS_REPO}/blob/master/${file}`

/**
 * The directories of a family, from its defaults file: one to a code, in the order of the codes, each with the requirements 5chan
 * would check a board against (a seedit route sets none that a record can be checked against).
 * @param {Family} family @param {unknown} defaults the file as parsed @returns {Directory[]}
 */
export function directoriesOf (family, defaults) {
  const table = typeof defaults === 'object' && defaults !== null ? /** @type {{ directories?: unknown }} */ (defaults).directories : null
  if (typeof table !== 'object' || table === null || Array.isArray(table)) return []
  return Object.entries(table)
    .filter(([code, one]) => CODE.test(code) && typeof one === 'object' && one !== null)
    .sort(([one], [other]) => (one < other ? -1 : one > other ? 1 : 0))
    .map(([code, one]) => {
      const entry = /** @type {{ title?: unknown, features?: unknown, rules?: unknown }} */ (one)
      return { code, title: typeof entry.title === 'string' && entry.title !== '' ? entry.title : family === 'seedit' ? `s/${code}` : `/${code}/`, file: fileOf(family, code), requirements: family === '5chan' ? requirementsOf(entry) : [] }
    })
}

/** The address that opens a new issue of the lists with this title and body filled in. @param {{ title: string, body: string }} issue */
export function issueUrl ({ title, body }) {
  const url = new URL(`${LISTS_REPO}/issues/new`)
  url.searchParams.set('title', title)
  url.searchParams.set('body', body)
  return url.toString()
}

/**
 * Node reads the signed message from a file, takes the Ed25519 key out of the peer ID (base 58 of `00 24 08 01 12 20` and the 32
 * bytes of the key) and checks the signature. No character in it is one a shell acts on inside double quotes.
 */
export const VERIFY_SCRIPT = "const[id,sig,file]=process.argv.slice(1);const A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const ch of id)n=n*58n+BigInt(A.indexOf(ch));const raw=Buffer.from(n.toString(16).padStart(76,'0'),'hex').subarray(6);const cr=require('crypto');const key=cr.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),raw]),format:'der',type:'spki'});console.log(cr.verify(null,Buffer.from(require('fs').readFileSync(file,'utf8').trimEnd()),key,Buffer.from(sig,'base64')))"

/** The one line a reviewer runs: it prints `true` when the board's key signed the message in `msg.txt`. @param {{ publicKey: string, signature: string }} request */
export const verifyCommand = ({ publicKey, signature }) => `node -e "${VERIFY_SCRIPT}" ${publicKey} ${signature} msg.txt`

/**
 * The issue for a listing: a title and a body in markdown.
 * @param {{ family: Family, directory: Directory, address: string, signed: Signed, unmet: import('./listing-requirements.js').Requirement[] }} request
 * `unmet` is what the board's record misses of the directory's requirements, none for a family that sets none.
 */
export function requestOf ({ family, directory, address, signed, unmet }) {
  const { entries, what } = FAMILIES[family]
  const seedit = family === 'seedit'
  const total = directory.requirements.length
  const check = seedit ? [] : [
    unmet.length === 0
      ? `Checked in the board's own record, by the node that hosts it: it meets all ${String(total)} requirements of the directory.`
      : `Checked in the board's own record, by the node that hosts it: it misses ${String(unmet.length)} of ${String(total)} requirements of the directory: ${unmet.map(wordsOf).join('; ')}.`,
    ''
  ]
  const body = [
    '## Directory', seedit ? `s/${directory.code}` : directory.title, '', `Directory file: ${blobUrl(directory.file)}`, '',
    `## ${seedit ? 'Community' : 'Board'}`, `Address: ${address}`, `Public key: ${signed.publicKey}`, '', ...check,
    '## Entry', `If it fits the directory, add it to \`${entries}\` in the file above:`, '', '```json', JSON.stringify(signed.entry, null, 2), '```', '',
    `## Signed by the ${what}'s key`,
    `This request is signed with the key of the ${what} itself (Ed25519), so a reviewer can check that its owner sent it.`, '', '```', signed.message, '```', '',
    `Signature (base64): ${signed.signature}`, '',
    `Verify: save the message above as msg.txt, then run: ${verifyCommand(signed)}`
  ].join('\n')
  return { title: seedit ? `Propose a community for s/${directory.code}: ${address}` : `Add a board to ${directory.title}: ${address}`, body }
}

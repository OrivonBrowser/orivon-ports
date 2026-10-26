// The addresses (IPNS names) this browser holds the key of, kept in the settings store under one key.
// Each wiki publishes under an address of its own: a record signed here points the name at the
// version just published. The pure helpers come first; the storage and the flows follow.

import { createRecord, generateNameKey, nameOf, parseName, parseRecord } from './ipfs/ipns.js'
import { fromHex, recordBytes, toBase64, toHex } from './name-files.js'
import * as store from './store.js'

/** How long a record the editor signs stays valid: long enough that anyone holding the file can republish it. */
export const RECORD_DAYS = 3650
export const RECORD_TTL_MS = 5 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const SETTING = 'names'

/**
 * @typedef {import('./name-files.js').NameVersion} NameVersion
 * @typedef {{ name: string, seed: string, label: string, createdAt: number, sequence: number, record: string | null,
 *   accepted: boolean, keptUntil: number | null, history: NameVersion[] }} NameEntry
 * `seed` is the secret key in hex. `sequence` is the last one signed (-1 for none), `record` the newest signed
 * record in base64, `accepted` whether Orivon's node took it.
 */

// Pure

/** The sequence of the next record: after the last, and never behind the clock, so a key used from two browsers moves forward. @param {{ sequence: number }} entry @param {number} [now] */
export function nextSequence (entry, now = Date.now()) {
  return Math.max(entry.sequence + 1, Math.floor(now / 1000))
}

/** What a record points at. @param {string} cid */
export function recordValue (cid) {
  return `/ipfs/${cid}`
}

/** Versions of both lists, once each, oldest first. @param {NameVersion[]} a @param {NameVersion[]} b */
export function mergeHistory (a, b) {
  /** @type {Map<string, NameVersion>} */
  const byKey = new Map()
  for (const version of [...a, ...b]) byKey.set(`${version.cid}:${version.sequence}`, version)
  return [...byKey.values()].sort((x, y) => x.sequence - y.sequence || x.at - y.at)
}

/** The title readers of the address see now: that of the last version published under it. @param {NameEntry} entry */
export function shownTitle (entry) {
  return entry.history.at(-1)?.title || entry.label || 'an untitled wiki'
}

/**
 * When a record made by this editor was signed, read back from its sequence (a Unix time in seconds);
 * null for a sequence another program counted. @param {number} sequence @param {number} [now]
 */
export function sequenceTime (sequence, now = Date.now()) {
  return sequence >= 1_500_000_000 && sequence * 1000 <= now + DAY_MS ? sequence * 1000 : null
}

/**
 * What the address is doing, for a person. `unconfirmed`: a record was signed and Orivon's node has not taken it.
 * @param {NameEntry} entry @param {number} [now]
 * @returns {{ kind: 'unpublished' | 'unconfirmed' | 'kept' | 'lapsed', until: number | null }}
 */
export function keepState (entry, now = Date.now()) {
  if (entry.record === null) return { kind: 'unpublished', until: null }
  if (!entry.accepted) return { kind: 'unconfirmed', until: null }
  if (entry.keptUntil !== null && entry.keptUntil <= now) return { kind: 'lapsed', until: entry.keptUntil }
  return { kind: 'kept', until: entry.keptUntil }
}

/** Whether sending the saved record to Orivon's node again would change anything. @param {NameEntry} entry @param {number} [now] */
export function canKeepAgain (entry, now = Date.now()) {
  const { kind } = keepState(entry, now)
  return kind === 'unconfirmed' || kind === 'lapsed'
}

/**
 * The addresses Publish offers for a wiki: its own when this browser holds the key, the others held,
 * and which is the default. A name the wiki has but this browser holds no key of is `lost`.
 * @param {{ name?: string | null }} wiki @param {NameEntry[]} held
 * @returns {{ own: NameEntry | undefined, lost: string | null, others: NameEntry[], first: 'update' | 'new' }}
 */
export function addressChoices (wiki, held) {
  const name = wiki.name ?? null
  const own = name === null ? undefined : held.find((entry) => entry.name === name)
  return {
    own,
    lost: name !== null && own === undefined ? name : null,
    others: held.filter((entry) => entry.name !== name),
    first: own === undefined ? 'new' : 'update'
  }
}

/** @param {unknown} raw @returns {NameEntry | null} */
function normaliseEntry (raw) {
  const entry = /** @type {any} */ (raw)
  if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string' || !/^[0-9a-f]{64}$/.test(entry.seed)) return null
  try {
    parseName(entry.name)
  } catch {
    return null
  }
  return {
    name: entry.name,
    seed: entry.seed,
    label: typeof entry.label === 'string' ? entry.label : '',
    createdAt: Number(entry.createdAt) || 0,
    sequence: Number.isSafeInteger(entry.sequence) ? entry.sequence : -1,
    record: typeof entry.record === 'string' ? entry.record : null,
    accepted: entry.accepted === true,
    keptUntil: Number.isFinite(entry.keptUntil) ? entry.keptUntil : null,
    history: Array.isArray(entry.history) ? entry.history : []
  }
}

// Storage

/** @returns {Promise<NameEntry[]>} */
export async function loadNames () {
  const saved = await store.getSetting(SETTING, /** @type {unknown} */ ([]))
  return (Array.isArray(saved) ? saved : []).map(normaliseEntry).filter((entry) => entry !== null)
}

/** @param {string} name @returns {Promise<NameEntry | undefined>} */
export async function getName (name) {
  return (await loadNames()).find((entry) => entry.name === name)
}

/** Changes one held address in a single write. @param {string} name @param {(entry: NameEntry) => NameEntry} change @returns {Promise<NameEntry | undefined>} */
export async function updateName (name, change) {
  const list = await store.updateSetting(SETTING, /** @type {NameEntry[]} */ ([]), (current) => current.map((entry) => entry.name === name ? change(entry) : entry))
  return list.find((entry) => entry.name === name)
}

/** Deletes the key of an address from this browser. @param {string} name */
export async function removeName (name) {
  await store.updateSetting(SETTING, /** @type {NameEntry[]} */ ([]), (current) => current.filter((entry) => entry.name !== name))
}

/** Makes a new address and keeps its key. @param {string} label The title of the wiki it is for. @param {number} [now] */
export async function makeName (label, now = Date.now()) {
  const { seed, publicKey } = await generateNameKey()
  /** @type {NameEntry} */
  const entry = { name: nameOf(publicKey), seed: toHex(seed), label: label.slice(0, 120), createdAt: now, sequence: -1, record: null, accepted: false, keptUntil: null, history: [] }
  await store.updateSetting(SETTING, /** @type {NameEntry[]} */ ([]), (current) => [...current, entry])
  return entry
}

/**
 * Keeps an address from a key file. A key already held keeps its entry, and its history takes the file's.
 * @param {{ seed: Uint8Array, publicKey: Uint8Array, label: string, history: NameVersion[] }} key
 * @param {number} [now]
 * @returns {Promise<{ entry: NameEntry, existed: boolean }>}
 */
export async function importKey ({ seed, publicKey, label, history }, now = Date.now()) {
  const name = nameOf(publicKey)
  const existed = (await getName(name)) !== undefined
  if (!existed) {
    /** @type {NameEntry} */
    const fresh = { name, seed: toHex(seed), label, createdAt: now, sequence: history.reduce((top, version) => Math.max(top, version.sequence), -1), record: null, accepted: false, keptUntil: null, history: mergeHistory([], history) }
    await store.updateSetting(SETTING, /** @type {NameEntry[]} */ ([]), (current) => current.some((entry) => entry.name === name) ? current : [...current, fresh])
  } else {
    await updateName(name, (entry) => ({ ...entry, label: entry.label || label, sequence: Math.max(entry.sequence, ...history.map((version) => version.sequence)), history: mergeHistory(entry.history, history) }))
  }
  return { entry: /** @type {NameEntry} */ (await getName(name)), existed }
}

/** An address never signs behind a record that exists: lifts its sequence to at least `sequence`. @param {string} name @param {number} sequence */
export async function raiseSequence (name, sequence) {
  await updateName(name, (entry) => ({ ...entry, sequence: Math.max(entry.sequence, sequence) }))
}

/** Names an address's wiki when it has no title yet. @param {string} name @param {string} label */
export async function nameLabel (name, label) {
  await updateName(name, (entry) => entry.label === '' ? { ...entry, label: label.slice(0, 120) } : entry)
}

/**
 * Signs the record that points an address at a version, and keeps it on the entry as not yet taken by Orivon's
 * node. A record already saved for this version is returned as it is, so a retry sends the same one.
 * @param {string} name @param {{ cid: string, title: string, now?: number }} version
 * @returns {Promise<{ bytes: Uint8Array, sequence: number }>}
 */
export async function signVersion (name, { cid, title, now = Date.now() }) {
  const entry = await getName(name)
  if (entry === undefined) throw new Error('This browser does not hold the key of that address.')
  const saved = savedRecord(entry)
  if (saved !== null && saved.record.value === recordValue(cid)) return { bytes: saved.bytes, sequence: saved.record.sequence }
  const sequence = nextSequence(entry, now)
  const bytes = await createRecord({ seed: fromHex(entry.seed), value: recordValue(cid), sequence, validity: new Date(now + RECORD_DAYS * DAY_MS), ttlMs: RECORD_TTL_MS })
  await updateName(name, (current) => ({
    ...current,
    sequence: Math.max(current.sequence, sequence),
    record: toBase64(bytes),
    accepted: false,
    keptUntil: null,
    history: mergeHistory(current.history, [{ cid, at: now, sequence, title }])
  }))
  return { bytes, sequence }
}

/** Notes that Orivon's node took the record of `sequence`, if it is still the newest. @param {string} name @param {number} sequence @param {number} keptUntil */
export async function markKept (name, sequence, keptUntil) {
  await updateName(name, (entry) => entry.sequence === sequence ? { ...entry, accepted: true, keptUntil } : entry)
}

/** The record an entry holds, as bytes to send, with its sequence. @param {NameEntry} entry */
export function savedRecord (entry) {
  const bytes = recordBytes(entry)
  return bytes === null ? null : { bytes, record: parseRecord(bytes) }
}

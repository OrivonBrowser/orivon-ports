// Turning what the checks found into plain words. Pure: a row in, a verdict out.
//
// A row's levels: 'works', 'slow' (works, took over 15 s), 'broken' (a check found a fault),
// 'unsure' (a check could not be made, so nothing can be claimed either way), 'pending'.

import { shorten } from './cid.js'

export const SLOW_MS = 15_000

/**
 * Which of the IPNS records the sources returned counts. Records with a bad signature are
 * ignored; the highest sequence among those still valid wins, and a stale source is named.
 * @typedef {{
 *   source: string, error?: string, sequence?: number, value?: string, cid?: string | null,
 *   expires?: Date | null, expired?: boolean, signature?: string
 * }} RecordEntry
 * @param {RecordEntry[]} entries one per source asked
 * @returns {{
 *   status: 'ok' | 'expired' | 'invalid' | 'none', best: RecordEntry | null, agreeing: number,
 *   answered: number, total: number, stale: string[], conflicts: string[]
 * }}
 */
export function chooseRecord (entries) {
  const answered = entries.filter((entry) => entry.sequence !== undefined)
  const usable = answered.filter((entry) => entry.signature !== 'invalid')
  const live = usable.filter((entry) => !entry.expired)
  const pool = live.length > 0 ? live : usable
  const best = pool.reduce((top, entry) => (top === null || /** @type {number} */ (entry.sequence) > /** @type {number} */ (top.sequence) ? entry : top), /** @type {RecordEntry | null} */ (null))
  const base = { answered: answered.length, total: entries.length, stale: /** @type {string[]} */ ([]), conflicts: /** @type {string[]} */ ([]) }
  if (!best) return { ...base, status: answered.length > 0 ? 'invalid' : 'none', best: null, agreeing: 0 }
  const agreeing = usable.filter((entry) => entry.sequence === best.sequence && entry.value === best.value)
  return {
    ...base,
    status: live.length > 0 ? 'ok' : 'expired',
    best,
    agreeing: agreeing.length,
    stale: usable.filter((entry) => /** @type {number} */ (entry.sequence) < /** @type {number} */ (best.sequence)).map((entry) => entry.source),
    conflicts: usable.filter((entry) => entry.sequence === best.sequence && entry.value !== best.value).map((entry) => entry.source)
  }
}

/**
 * Whether a .eth name points at the key it should.
 * @param {{ status: string, contenthash?: { kind: string, uri?: string, cid?: string } }} lookup
 * @param {string} key
 * @returns {{ status: 'ok' | 'elsewhere' | 'noresolver' | 'nocontenthash' | 'unreachable', target: string | null }}
 */
export function nameState (lookup, key) {
  if (lookup.status !== 'found') return { status: /** @type {'noresolver' | 'nocontenthash' | 'unreachable'} */ (lookup.status), target: null }
  const hash = lookup.contenthash
  if (hash?.kind === 'ipns' && hash.cid === key) return { status: 'ok', target: hash.uri ?? null }
  return { status: 'elsewhere', target: hash?.uri ?? null }
}

/** @param {Date} date */
const day = (date) => date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

/**
 * The first fault in pipeline order (names, record, content, providers). A fault is 'broken';
 * a check that could not be made is 'unsure' and is reported only when nothing is broken.
 * @param {any} row
 * @returns {{ level: 'works' | 'slow' | 'broken' | 'unsure', text: string }}
 */
export function rowVerdict (row) {
  /** @type {{ level: 'broken' | 'unsure', text: string }[]} */
  const faults = []
  for (const entry of row.names) {
    const words = {
      elsewhere: `${entry.name} points at ${entry.target ? shorten(entry.target, 18, 6) : 'something else'}, not at this site`,
      noresolver: `${entry.name} has no resolver yet, so it points at nothing`,
      nocontenthash: `${entry.name} points at nothing`
    }[/** @type {'elsewhere' | 'noresolver' | 'nocontenthash'} */ (entry.status)]
    if (words) faults.push({ level: 'broken', text: words })
    if (entry.status === 'unreachable') faults.push({ level: 'unsure', text: `Ethereum could not be asked about ${entry.name}: ${entry.detail ?? 'no RPC answered'}` })
  }
  const record = row.record
  if (record.status === 'none') faults.push({ level: 'broken', text: 'No public service returned the ipns:// record' })
  else if (record.status === 'invalid') faults.push({ level: 'broken', text: 'The ipns:// record\'s signature does not match its name' })
  else if (record.status === 'expired') faults.push({ level: 'broken', text: `The ipns:// record expired on ${record.best?.expires ? day(record.best.expires) : 'an unknown date'}` })
  const content = row.content
  if (content?.failure) faults.push({ level: 'broken', text: content.failure })
  else if (content?.warn) faults.push({ level: 'unsure', text: content.warn })
  const providers = row.providers
  if (providers.status === 'ok' && providers.count === 0) faults.push({ level: 'broken', text: 'Nobody announces this content on the public IPFS network' })
  if (providers.status === 'error') faults.push({ level: 'unsure', text: `Could not ask who provides this content: ${providers.error}` })
  const broken = faults.find((fault) => fault.level === 'broken')
  const fault = broken ?? faults[0]
  if (fault) return fault
  if (row.ms > SLOW_MS) return { level: 'slow', text: `Everything checked out, but it took ${(row.ms / 1000).toFixed(0)} s` }
  return { level: 'works', text: 'Every file arrived and matched its hash' }
}

/**
 * What the banner says: green only when nothing is broken, unsure, slow or flagged.
 * @param {{ label: string, verdict: { level: string, text: string }, warnings: string[] }[]} items
 * @returns {{ level: 'ok' | 'warn' | 'bad' | 'pending', headline: string, lines: string[] }}
 */
export function banner (items) {
  if (items.some((item) => item.verdict.level === 'pending')) return { level: 'pending', headline: 'Checking…', lines: [] }
  const broken = items.filter((item) => item.verdict.level === 'broken')
  if (broken.length > 0) return { level: 'bad', headline: broken.length === 1 ? 'One thing is broken' : `${broken.length} things are broken`, lines: broken.map((item) => `${item.label}: ${item.verdict.text}`) }
  const doubtful = items.filter((item) => item.verdict.level !== 'works' || item.warnings.length > 0)
  if (doubtful.length > 0) return { level: 'warn', headline: 'Everything is served, with something to look at', lines: doubtful.map((item) => `${item.label}: ${item.verdict.level === 'works' ? item.warnings[0] : item.verdict.text}`) }
  return { level: 'ok', headline: 'Everything works', lines: [] }
}

/**
 * The three numbers in the summary tiles.
 * @param {any[]} rows
 * @param {{ verdict: { level: string }, kept: boolean }[]} releases
 */
export function summarise (rows, releases) {
  const names = rows.flatMap((row) => row.names)
  const kept = releases.filter((release) => release.kept)
  return {
    sites: { good: rows.filter((row) => row.verdict.level === 'works' || row.verdict.level === 'slow').length, total: rows.length },
    names: { good: names.filter((entry) => entry.status === 'ok').length, total: names.length },
    releases: { good: kept.filter((release) => release.verdict.level === 'works').length, total: kept.length }
  }
}

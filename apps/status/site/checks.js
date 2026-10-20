// The check pipeline. Each row asks Ethereum for its names, three sources for its IPNS record,
// then fetches the content and asks who provides it. Rows and releases are plain mutable
// objects; `onUpdate` says one changed, and the view redraws from them.

import { cidToString, parseCid } from './cid.js'
import { checkContent, emptyContent } from './content.js'
import { flagWarnings } from './derive.js'
import { countProviders, createContext, fetchRecords, fetchReleases, fetchScoreFile, githubRead, lookupName } from './fetchers.js'
import { expiry, parseRecord, valueCid, verifyRecord } from './ipns.js'
import { chooseRelease, parseRecipe, pinAge } from './pins.js'
import { classifyReleases } from './releases.js'
import { bucketOf, findEvaluation, parseJsonBytes, readProvider } from './score.js'
import { PORTS, RELEASES, SITES } from './targets.js'
import { chooseRecord, nameState, rowVerdict } from './verdict.js'

/**
 * @typedef {{ status: 'pending' | 'skipped' } | { status: 'limited' | 'error', error: string }
 *   | ({ status: 'ok' } & ReturnType<typeof pinAge> & { url: string })} PinState
 * @typedef {({ status: 'pending' | 'skipped' | 'none' } | { status: 'error', error: string }
 *   | { status: 'found', level: number, privacy: boolean, evaluated: string }) & { provider?: string }} ScoreState
 */

const ROWS_AT_A_TIME = 3
const PENDING = { level: 'pending', text: 'Checking…' }

/** @param {import('./targets.js').Site} site */
export function newRow (site) {
  return {
    site,
    names: site.names.map((name) => ({ name, status: 'pending', target: null, detail: '' })),
    record: { status: 'pending', entries: [], best: null, agreeing: 0, answered: 0, total: 0, stale: [], conflicts: [] },
    cid: /** @type {string | null} */ (null),
    content: /** @type {import('./content.js').Content | null} */ (null),
    providers: { status: 'pending', count: 0, error: '' },
    pin: /** @type {PinState} */ (site.port ? { status: 'pending' } : { status: 'skipped' }),
    score: /** @type {ScoreState} */ (site.kind === 'site' ? { status: 'pending' } : { status: 'skipped' }),
    requests: /** @type {import('./fetchers.js').RequestLine[]} */ ([]),
    warnings: /** @type {string[]} */ ([]),
    ms: 0,
    done: false,
    verdict: PENDING
  }
}

/**
 * One source's answer, parsed and verified.
 * @param {string} key
 * @param {{ source: string, ok: boolean, status: string, bytes: Uint8Array, ms: number }} answer
 * @param {number} now
 */
async function readAnswer (key, answer, now) {
  // `ms` is how long that source took, which the row's time is built from.
  if (!answer.ok) return { source: answer.source, error: `answered ${answer.status}`, ms: answer.ms }
  try {
    const record = parseRecord(answer.bytes)
    const check = await verifyRecord(record, key)
    const expires = expiry(record)
    return {
      source: answer.source,
      ms: answer.ms,
      sequence: record.sequence,
      value: record.value,
      cid: valueCid(record),
      expires,
      expired: expires !== null && expires.getTime() < now,
      signature: check.signature,
      reason: check.reason
    }
  } catch {
    return { source: answer.source, error: 'sent something that is not an IPNS record', ms: answer.ms }
  }
}

/** @param {ReturnType<typeof newRow>} row */
function warningsOf (row) {
  /** @type {string[]} */
  const out = []
  if (row.record.stale.length > 0) out.push(`${row.record.stale.join(' and ')} still serve${row.record.stale.length === 1 ? 's' : ''} an older copy of the ipns:// record`)
  if (row.record.conflicts.length > 0) out.push(`${row.record.conflicts.join(' and ')} disagree${row.record.conflicts.length === 1 ? 's' : ''} about the record's value`)
  const unchecked = /** @type {any} */ (row.record.best)?.signature === 'not checked'
  if (unchecked) out.push('The record\'s signature could not be checked in this browser')
  out.push(...flagWarnings(row, Date.now()))
  return out
}


/**
 * The app's pin against its upstream: the recipe on the ports repository's main branch says
 * where the pin is, and two reads of the upstream repository give the pinned commit's date and
 * the newest release that counts. A GitHub that will not answer is "not checked", not a fault.
 * @param {import('./fetchers.js').Context} ctx
 * @param {import('./targets.js').Site} site
 * @returns {Promise<PinState>}
 */
export async function checkPin (ctx, site) {
  if (!site.port) return { status: 'skipped' }
  const recipeReply = await githubRead(ctx, 'pin recipe', `/repos/${PORTS.repo}/contents/apps/${site.port}/recipe.json?ref=${PORTS.branch}`, 'application/vnd.github.raw+json')
  if (recipeReply.status !== 'ok') return { status: recipeReply.status === 'missing' ? 'error' : recipeReply.status, error: recipeReply.error }
  const recipe = parseRecipe(recipeReply.text)
  if (!recipe) return { status: 'error', error: 'the recipe does not name an upstream commit' }
  const [commit, releases] = await Promise.all([
    githubRead(ctx, 'pinned commit', `/repos/${recipe.repo}/commits/${recipe.ref}`),
    githubRead(ctx, 'upstream releases', `/repos/${recipe.repo}/releases?per_page=30`)
  ])
  for (const reply of [commit, releases]) if (reply.status !== 'ok') return { status: reply.status === 'missing' ? 'error' : reply.status, error: reply.error }
  try {
    const pinned = new Date(JSON.parse(/** @type {{ text: string }} */ (commit).text)?.commit?.committer?.date)
    if (Number.isNaN(pinned.getTime())) throw new Error('no date')
    const release = chooseRelease(JSON.parse(/** @type {{ text: string }} */ (releases).text), recipe)
    return { status: 'ok', ...pinAge(pinned, release), url: release?.url ?? '' }
  } catch {
    return { status: 'error', error: 'GitHub sent something this page cannot read' }
  }
}

/**
 * The provider's evaluation of this build, found by the bucket its identifier is filed under.
 * @param {import('./fetchers.js').Context} ctx
 * @param {string} cid the build's root CID
 * @param {{ provider: Promise<{ name: string, bucketHexChars: 1 | 2 } | null> | null }} shared
 * @returns {Promise<ScoreState>}
 */
export async function checkScore (ctx, cid, shared) {
  shared.provider ??= (async () => {
    const reply = await fetchScoreFile(createContext(), 'provider.json')
    return reply.status === 'ok' ? readProvider(parseJsonBytes(reply.bytes)) : null
  })()
  const provider = await shared.provider
  if (!provider) return { status: 'error', error: 'the Web3 Score provider could not be read' }
  const id = `cid:${cid}`
  const bucket = await bucketOf(id, provider.bucketHexChars)
  const reply = await fetchScoreFile(ctx, `website/${bucket}.json`)
  if (reply.status === 'error') return { status: 'error', error: reply.error, provider: provider.name }
  const evaluation = reply.status === 'ok' ? findEvaluation(parseJsonBytes(reply.bytes), id, bucket) : null
  return evaluation ? { status: 'found', ...evaluation, provider: provider.name } : { status: 'none', provider: provider.name }
}

/**
 * @param {import('./targets.js').Site} site
 * @param {(row: ReturnType<typeof newRow>) => void} onUpdate
 * @param {{ provider: Promise<{ name: string, bucketHexChars: 1 | 2 } | null> | null }} [shared] what rows of one run ask once
 */
export async function checkSite (site, onUpdate, shared = { provider: null }) {
  const row = newRow(site)
  const started = performance.now()
  const ctx = createContext(() => onUpdate(row))
  row.requests = ctx.log
  onUpdate(row)

  let namesMs = 0
  let pathMs = 0
  const pin = checkPin(ctx, site).catch(() => /** @type {PinState} */ ({ status: 'error', error: 'the pin could not be read' })).then((state) => { row.pin = state; onUpdate(row) })
  const names = Promise.all(site.names.map(async (name, i) => {
    const lookup = await lookupName(ctx, name)
    namesMs = Math.max(namesMs, performance.now() - started)
    Object.assign(/** @type {object} */ (row.names[i]), nameState(lookup, site.ipns), { detail: lookup.detail ?? '' })
    onUpdate(row)
  }))

  const rest = (async () => {
    const answers = await fetchRecords(ctx, site.ipns)
    const entries = await Promise.all(answers.map((answer) => readAnswer(site.ipns, answer, Date.now())))
    Object.assign(row.record, chooseRecord(entries), { entries })
    pathMs = Math.min(Infinity, ...entries.filter((entry) => entry.sequence !== undefined).map((entry) => entry.ms))
    onUpdate(row)
    const best = /** @type {any} */ (row.record.best)
    if (!best) {
      row.providers = { status: 'skipped', count: 0, error: '' }
      row.score = { status: 'skipped' }
      return
    }
    if (!best.cid) {
      row.content = Object.assign(emptyContent(site.kind), { done: true, failure: 'The ipns:// record does not point at an ipfs:// address' })
      row.providers = { status: 'skipped', count: 0, error: '' }
      return
    }
    row.cid = cidToString(parseCid(best.cid))
    onUpdate(row)
    const cid = row.cid
    const stepStart = performance.now()
    let stepMs = 0
    await Promise.all([
      checkContent(ctx, cid, site.kind, () => onUpdate(row)).then((content) => {
        stepMs = Math.max(stepMs, content.ms)
        row.content = content
        onUpdate(row)
      }),
      countProviders(ctx, cid).then((providers) => {
        stepMs = Math.max(stepMs, performance.now() - stepStart)
        row.providers = { count: 0, error: '', ...providers }
        onUpdate(row)
      }),
      // Asked beside the content, but not part of the time a visitor waits: it is not a check of the page.
      site.kind === 'site' ? checkScore(ctx, cid, shared).catch(() => /** @type {ScoreState} */ ({ status: 'error', error: 'the evaluation could not be read' })).then((state) => { row.score = state; onUpdate(row) }) : Promise.resolve()
    ])
    pathMs += stepMs
  })()

  await Promise.all([names, rest, pin])
  if (row.score.status === 'pending') row.score = { status: 'skipped' }
  // How long a visitor waits: the slower of the names and (fastest record + content or providers), not the
  // slowest source of three, whose timeout would make every row look slow.
  row.ms = Math.max(namesMs, Number.isFinite(pathMs) ? pathMs : 0)
  row.warnings = warningsOf(row)
  row.done = true
  row.verdict = rowVerdict(row)
  onUpdate(row)
  return row
}

/**
 * The newest releases that carry an IPFS folder, each checked as a folder.
 * @param {(state: { error: string | null, releases: any[], done: boolean }) => void} onUpdate
 */
export async function checkReleases (onUpdate) {
  const ctx = createContext()
  /** @type {{ error: string | null, releases: any[], done: boolean }} */
  const state = { error: null, releases: [], done: false }
  try {
    const list = classifyReleases(await fetchReleases(ctx, RELEASES.repo), RELEASES.keep)
    state.releases = list.map((release) => ({ ...release, content: null, verdict: release.plan === 'check' ? PENDING : { level: 'skipped', text: '' } }))
  } catch (error) {
    state.error = `Could not read the releases from GitHub: ${error instanceof Error ? error.message : error}`
    state.done = true
    onUpdate(state)
    return state
  }
  onUpdate(state)
  await Promise.all(state.releases.filter((release) => release.plan === 'check').map(async (release) => {
    const releaseCtx = createContext()
    release.content = await checkContent(releaseCtx, release.cid, 'folder', () => onUpdate(state))
    release.requests = releaseCtx.log
    release.verdict = release.content.failure
      ? { level: 'broken', text: release.content.failure }
      : release.content.warn ? { level: 'unsure', text: release.content.warn } : { level: 'works', text: 'Every file\'s sampled blocks arrived and matched their hashes' }
    onUpdate(state)
  }))
  state.done = true
  onUpdate(state)
  return state
}

/**
 * Every row three at a time, and the releases alongside as the first job.
 * @param {{ onRow: (row: ReturnType<typeof newRow>) => void, onReleases: (state: any) => void }} hooks
 */
export async function checkAll ({ onRow, onReleases }) {
  /** @type {(() => Promise<unknown>)[]} */
  const shared = { provider: null }
  const jobs = [() => checkReleases(onReleases), ...SITES.map((site) => () => checkSite(site, onRow, shared))]
  const workers = Array.from({ length: ROWS_AT_A_TIME }, async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) await job()
  })
  await Promise.all(workers)
}

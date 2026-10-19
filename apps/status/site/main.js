// Entry: builds the page, runs the checks, redraws as results arrive.

import { checkAll, newRow } from './checks.js'
import { el, fill } from './dom.js'
import { formatClock, formatSeconds } from './format.js'
import { releaseOfCid } from './releases.js'
import { RELEASES, SITES } from './targets.js'
import { banner, summarise } from './verdict.js'
import { bannerView, releaseRow, releasesTable, siteBody, sitesTable, tilesView } from './view.js'

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id))
const slots = { banner: $('banner'), tiles: $('tiles'), clock: $('clock'), again: /** @type {HTMLButtonElement} */ ($('again')), sites: $('sites'), releases: $('releases') }

/** @type {Map<string, any>} */
let rows = new Map()
let releaseState = { error: /** @type {string | null} */ (null), releases: /** @type {any[]} */ ([]), done: false }
let run = { started: 0, finished: 0, at: new Date(), running: false, generation: 0 }
let scheduled = false

const sitesBoard = sitesTable()
const releasesBoard = releasesTable()
slots.sites.append(sitesBoard)
slots.releases.append(releasesBoard, el('p', { id: 'releases-note', class: 'note' }))

/** Swaps one tbody for its new drawing, keeping its request list open if the visitor opened it. */
function place (/** @type {HTMLTableElement} */ table, /** @type {string} */ id, /** @type {(open: boolean) => HTMLElement} */ draw) {
  const old = table.querySelector(`tbody[data-id="${CSS.escape(id)}"]`)
  const next = draw(Boolean(old?.querySelector('details[open]')))
  if (old) old.replaceWith(next)
  else table.append(next)
}

function render () {
  scheduled = false
  const list = [...rows.values()]
  for (const row of list) place(sitesBoard, row.site.id, (open) => siteBody(row, row.site.id === 'latest-release' ? releaseOfCid(releaseState.releases, row.cid) : null, open))
  for (const release of releaseState.releases) place(releasesBoard, release.tag, (open) => releaseRow(release, RELEASES.keep, open))
  $('releases-note').textContent = releaseState.error ?? (releaseState.releases.length === 0 && !releaseState.done ? 'Reading the release list from GitHub…' : '')

  const kept = releaseState.releases.filter((release) => release.plan === 'check')
  const items = [
    ...list.map((row) => ({ label: row.site.label, verdict: row.verdict, warnings: row.warnings })),
    ...kept.map((release) => ({ label: `Release ${release.tag}`, verdict: release.verdict, warnings: [] })),
    ...(releaseState.error ? [{ label: 'Releases', verdict: { level: 'unsure', text: releaseState.error }, warnings: [] }] : []),
    ...(releaseState.done ? [] : [{ label: 'Releases', verdict: { level: 'pending', text: '' }, warnings: [] }])
  ]
  fill(slots.banner, bannerView(banner(items)))
  fill(slots.tiles, tilesView(summarise(list, kept.map((release) => ({ verdict: release.verdict, kept: true })))))
  const elapsed = (run.running ? performance.now() : run.finished) - run.started
  slots.clock.textContent = run.running ? `Checking… ${formatSeconds(elapsed)} so far` : `Checked at ${formatClock(run.at)}, took ${formatSeconds(elapsed)}`
  slots.again.disabled = run.running
}

function schedule () {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(render)
}

async function start () {
  const generation = ++run.generation
  rows = new Map(SITES.map((site) => [site.id, newRow(site)]))
  releaseState = { error: null, releases: [], done: false }
  for (const board of [sitesBoard, releasesBoard]) for (const body of board.querySelectorAll('tbody')) body.remove()
  run = { started: performance.now(), finished: 0, at: new Date(), running: true, generation }
  render()
  const tick = setInterval(schedule, 1000)
  await checkAll({
    onRow: (row) => { if (generation === run.generation) { rows.set(row.site.id, row); schedule() } },
    onReleases: (state) => { if (generation === run.generation) { releaseState = { ...state }; schedule() } }
  })
  clearInterval(tick)
  run.finished = performance.now()
  run.running = false
  run.at = new Date()
  render()
}

slots.again.addEventListener('click', () => { void start() })
void start()

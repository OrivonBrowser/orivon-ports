// Entry: builds the page, runs the checks, redraws as results arrive.

import { checkAll, newRow } from './checks.js'
import { reachableGateways } from './fetchers.js'
import { el, fill } from './dom.js'
import { formatClock, formatSeconds } from './format.js'
import { releaseOfCid } from './releases.js'
import { GATEWAYS, RELEASES, SITES } from './targets.js'
import { banner, summarise } from './verdict.js'
import { bannerView, releaseRow, releasesTable, siteBody, sitesTable, tilesView } from './view.js'

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id))
const slots = { banner: $('banner'), tiles: $('tiles'), clock: $('clock'), again: /** @type {HTMLButtonElement} */ ($('again')), sites: $('sites'), releases: $('releases') }

/** @type {Map<string, any>} */
let rows = new Map()
let releaseState = { error: /** @type {string | null} */ (null), releases: /** @type {any[]} */ ([]), done: false }
let run = { started: 0, finished: 0, at: new Date(), running: false, generation: 0, phase: 'reaching', unreachable: false }

/** How long the page waits for a first gateway: long enough for the visitor to answer Orivon's question about this page's connections. */
const REACH_TRIES = 20
const REACH_WAIT_MS = 3_000
const WAIT_HINT = 'If Orivon asks whether this page may connect to the services it checks through, allow it: the checks start as soon as a gateway answers.'
const UNREACHABLE_LINES = [
  'Nothing below was checked: a site cannot be judged from a browser that reaches no gateway.',
  'In Orivon, allow this page\'s connections when it asks, then press Check again.',
  'Some internet providers block IPFS gateways through their DNS. Turn on secure DNS (Orivon Settings, Privacy), or try another network.',
  `Tried: ${GATEWAYS.map((gateway) => new URL(gateway).host).join(', ')}.`
]
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
  const blocked = run.phase === 'reaching' || run.unreachable
  for (const node of [sitesBoard, releasesBoard, slots.tiles, $('releases-note')]) node.hidden = blocked
  if (run.phase === 'reaching') {
    fill(slots.banner, bannerView({ level: 'pending', headline: 'Connecting to the public IPFS gateways…', lines: [WAIT_HINT] }))
    slots.clock.textContent = `Waiting ${formatSeconds(performance.now() - run.started)} so far`
    slots.again.disabled = true
    return
  }
  if (run.unreachable) {
    fill(slots.banner, bannerView({ level: 'bad', headline: 'This browser cannot reach any public IPFS gateway', lines: UNREACHABLE_LINES }))
    slots.clock.textContent = `Tried until ${formatClock(run.at)}`
    slots.again.disabled = false
    return
  }
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
  run = { started: performance.now(), finished: 0, at: new Date(), running: true, generation, phase: 'reaching', unreachable: false }
  render()
  const tick = setInterval(schedule, 1000)
  let reachable = await reachableGateways()
  for (let tries = 1; reachable.length === 0 && tries < REACH_TRIES && generation === run.generation; tries++) {
    await new Promise((resolve) => setTimeout(resolve, REACH_WAIT_MS))
    reachable = await reachableGateways()
  }
  if (generation !== run.generation) { clearInterval(tick); return }
  if (reachable.length === 0) {
    clearInterval(tick)
    run = { ...run, running: false, finished: performance.now(), at: new Date(), phase: 'done', unreachable: true }
    render()
    return
  }
  run.phase = 'checking'
  run.started = performance.now()
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

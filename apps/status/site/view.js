// Drawing. Every function turns state into elements; nothing here fetches or decides.

import { shorten } from './cid.js'
import { el } from './dom.js'
import { formatBytes, formatDate, formatGateways, formatSeconds } from './format.js'
import { skippedText } from './releases.js'

const VERDICT_WORDS = { works: 'Works', slow: 'Slow', broken: 'Broken', unsure: 'Not sure', pending: 'Checking…', skipped: '' }
const NAME_WORDS = {
  pending: 'being asked',
  ok: 'points at this site\'s ipns:// name',
  elsewhere: 'points somewhere else',
  noresolver: 'has no resolver',
  nocontenthash: 'points at nothing',
  unreachable: 'could not be asked'
}

/** @param {{ level: string, text: string }} verdict */
function verdictCell (verdict) {
  return el('td', { 'data-label': 'Verdict', class: 'verdict-cell' },
    el('span', { class: `badge badge-${verdict.level}`, text: VERDICT_WORDS[/** @type {keyof typeof VERDICT_WORDS} */ (verdict.level)] ?? verdict.level }),
    el('span', { class: 'verdict-text', text: verdict.text }))
}

/** @param {import('./fetchers.js').RequestLine[]} lines @param {string} title */
function requestsDetails (lines, title) {
  const failed = lines.filter((line) => !/^2\d\d$/.test(line.status)).length
  return el('details', { class: 'requests' },
    el('summary', { text: `${title}: ${lines.length} request${lines.length === 1 ? '' : 's'}${failed ? `, ${failed} not successful` : ''}` }),
    el('table', { class: 'request-list' },
      el('thead', {}, el('tr', {}, el('th', { text: 'For' }), el('th', { text: 'Host' }), el('th', { text: 'Status' }), el('th', { text: 'Seconds' }))),
      el('tbody', {}, lines.map((line) => el('tr', {},
        el('td', { text: line.label }),
        el('td', { text: line.host }),
        el('td', { class: /^2\d\d$/.test(line.status) ? '' : 'bad', text: line.status }),
        el('td', { class: 'num', text: (line.ms / 1000).toFixed(2) }))))))
}

/** @param {any} row */
function namesCell (row) {
  return el('td', { 'data-label': '.eth names' }, el('ul', { class: 'plain' }, row.names.map((/** @type {any} */ entry) => el('li', {},
    el('span', { class: `mark mark-${entry.status}`, title: `${entry.name} ${NAME_WORDS[/** @type {keyof typeof NAME_WORDS} */ (entry.status)]}`, text: entry.status === 'ok' ? '✓' : entry.status === 'pending' ? '…' : '✗' }),
    ' ',
    el('a', { href: `https://${entry.name}/`, text: entry.name }),
    entry.status === 'ok' || entry.status === 'pending' ? null : el('span', { class: 'note', text: NAME_WORDS[/** @type {keyof typeof NAME_WORDS} */ (entry.status)] })))))
}

/** @param {any} row @param {string | null} releaseTag */
function buildCell (row, releaseTag) {
  if (!row.cid) return el('td', { 'data-label': 'Current build', text: row.done ? 'none found' : '…' })
  return el('td', { 'data-label': 'Current build' },
    el('a', { class: 'mono', href: `ipfs://${row.cid}`, title: `ipfs://${row.cid}`, text: shorten(row.cid, 12, 6) }),
    releaseTag ? el('span', { class: 'note', text: `is release ${releaseTag}` }) : null)
}

/** @param {any} row */
function recordCell (row) {
  const record = row.record
  if (record.status === 'pending') return el('td', { 'data-label': 'Record', text: '…' })
  const best = record.best
  if (!best) return el('td', { 'data-label': 'Record', class: 'bad', text: 'none found' })
  return el('td', { 'data-label': 'Record' },
    el('div', {}, `sequence ${best.sequence}`),
    el('div', { class: best.expired ? 'bad' : '' }, best.expires ? `${best.expired ? 'expired' : 'expires'} ${formatDate(best.expires)}` : 'no expiry'),
    el('div', { class: best.signature === 'valid' ? 'good' : best.signature === 'invalid' ? 'bad' : 'warn', text: `signature ${best.signature}` }),
    el('div', { text: `${record.agreeing} of ${record.answered} that answered agree` }),
    record.total > record.answered ? el('div', { class: 'warn', text: `${record.total - record.answered} of ${record.total} sources did not answer` }) : null,
    row.warnings.map((/** @type {string} */ warning) => el('div', { class: 'warn', text: warning })))
}

/** @param {any} row */
function pageCell (row) {
  const content = row.content
  if (!content) return el('td', { 'data-label': 'Page', text: row.done ? 'not fetched' : '…' })
  const gateways = formatGateways(content.gateways)
  if (content.kind === 'folder') {
    return el('td', { 'data-label': 'Page' }, `${content.checked}/${content.total} files sampled`, el('div', { class: 'note', text: `${formatBytes(content.bytes)} in ${formatSeconds(content.ms)}${gateways ? ' via ' + gateways : ''}` }))
  }
  if (content.fileBytes === null) return el('td', { 'data-label': 'Page' }, content.done ? 'not fetched' : '…', gateways ? el('div', { class: 'note', text: gateways }) : null)
  return el('td', { 'data-label': 'Page' }, `${formatBytes(content.fileBytes)} in ${formatSeconds(content.ms)}`, el('div', { class: 'note', text: `index.html, ${content.blocks - 1} more block${content.blocks === 2 ? '' : 's'}${gateways ? ', via ' + gateways : ''}` }))
}

/** @param {any} row */
function providersCell (row) {
  const providers = row.providers
  const words = providers.status === 'pending' ? '…' : providers.status === 'skipped' ? 'not asked' : providers.status === 'error' ? 'could not ask' : providers.count === 0 ? 'nobody' : `${providers.count} listed`
  return el('td', { 'data-label': 'Providers', class: providers.status === 'ok' && providers.count === 0 ? 'bad' : '', text: words })
}

/**
 * One site: its data row, then a row holding the request list.
 * @param {any} row
 * @param {string | null} releaseTag
 * @param {boolean} open
 */
export function siteBody (row, releaseTag, open) {
  const requests = requestsDetails(row.requests, 'Every request')
  if (open) requests.setAttribute('open', '')
  return el('tbody', { class: 'site', 'data-id': row.site.id },
    el('tr', { class: 'data-row' },
      el('th', { scope: 'row', 'data-label': 'Name', class: 'name-cell' }, row.site.label),
      namesCell(row),
      el('td', { 'data-label': 'ipns://' }, el('a', { class: 'mono key', href: `ipns://${row.site.ipns}`, text: row.site.ipns })),
      buildCell(row, releaseTag),
      recordCell(row),
      pageCell(row),
      providersCell(row),
      verdictCell(row.verdict)),
    el('tr', { class: 'request-row' }, el('td', { colspan: 8 }, requests)))
}

export function sitesTable () {
  return el('table', { class: 'board' },
    el('caption', { text: 'Sites and apps' }),
    el('thead', {}, el('tr', {}, ['Name', '.eth names', 'ipns://', 'Current build', 'Record', 'Page', 'Providers', 'Verdict'].map((title) => el('th', { scope: 'col', text: title })))))
}

/** @param {any} release @param {number} keep @param {boolean} open */
function releaseBody (release, keep, open) {
  const checked = release.plan === 'check'
  const content = release.content
  const verdict = checked ? release.verdict : { level: 'skipped', text: skippedText(release.plan, keep) }
  const requests = release.requests ? requestsDetails(release.requests, 'Every request') : null
  if (requests && open) requests.setAttribute('open', '')
  return el('tbody', { class: 'site', 'data-id': release.tag },
    el('tr', { class: 'data-row' },
      el('th', { scope: 'row', 'data-label': 'Tag', class: 'name-cell' }, el('a', { href: release.url, rel: 'noopener noreferrer', text: release.tag })),
      el('td', { 'data-label': 'Published', text: release.published.slice(0, 10) }),
      release.cid
        ? el('td', { 'data-label': 'ipfs://' }, el('a', { class: 'mono', href: `ipfs://${release.cid}`, title: `ipfs://${release.cid}`, text: shorten(release.cid, 12, 6) }))
        : el('td', { 'data-label': 'ipfs://', text: 'none' }),
      el('td', { 'data-label': 'Files checked' }, checked ? (content ? `${content.checked}/${content.total}` : '…') : '–',
        content && content.entries.length > 0 ? el('ul', { class: 'plain files' }, content.entries.map((/** @type {any} */ entry) => el('li', { class: entry.status === 'failed' ? 'bad' : '' },
          el('span', { class: 'mark', text: entry.status === 'ok' ? '✓' : entry.status === 'failed' ? '✗' : '…' }), ` ${entry.name}`,
          el('span', { class: 'note', text: `${formatBytes(entry.size)}, ${entry.status === 'failed' ? entry.error : entry.note}` })))) : null),
      verdictCell(verdict)),
    requests ? el('tr', { class: 'request-row' }, el('td', { colspan: 5 }, requests)) : null)
}

export function releasesTable () {
  return el('table', { class: 'board releases' },
    el('caption', { text: 'Releases' }),
    el('thead', {}, el('tr', {}, ['Tag', 'Published', 'ipfs://', 'Files checked', 'Verdict'].map((title) => el('th', { scope: 'col', text: title })))))
}

/** @param {any} release @param {number} keep @param {boolean} open */
export const releaseRow = (release, keep, open) => releaseBody(release, keep, open)

/** @param {{ level: string, headline: string, lines: string[] }} banner */
export function bannerView (banner) {
  return el('div', { class: `banner banner-${banner.level}`, role: 'status' },
    el('strong', { text: banner.headline }),
    banner.lines.length > 0 ? el('ul', {}, banner.lines.map((line) => el('li', { text: line }))) : null)
}

/** @param {{ sites: { good: number, total: number }, names: { good: number, total: number }, releases: { good: number, total: number } }} summary */
export function tilesView (summary) {
  const tile = (/** @type {string} */ title, /** @type {{ good: number, total: number }} */ pair) => el('div', { class: `tile ${pair.total > 0 && pair.good === pair.total ? 'tile-ok' : ''}` },
    el('div', { class: 'tile-number', text: `${pair.good}/${pair.total}` }),
    el('div', { class: 'tile-title', text: title }))
  return [tile('sites working', summary.sites), tile('.eth names right', summary.names), tile('releases served', summary.releases)]
}

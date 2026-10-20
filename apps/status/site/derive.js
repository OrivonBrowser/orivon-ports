// What the checks found, turned into the few words and flags a row shows for its provider
// count and its record's end of life. Pure: numbers and dates in, text and a level out.

/** A record that ends within this long is flagged: the name stops resolving unless it is republished. */
export const RECORD_WARN_MS = 24 * 60 * 60 * 1000

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * How long a duration reads as: the two largest units that matter, never "0 hours".
 * @param {number} ms a positive duration
 */
export function formatSpan (ms) {
  if (ms < HOUR_MS) return `${Math.max(1, Math.round(ms / 60_000))} min`
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)} h`
  const days = Math.floor(ms / DAY_MS)
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS)
  return hours === 0 || days >= 10 ? `${days} d` : `${days} d ${hours} h`
}

/**
 * The record's end of life: when it stops being valid, and whether that is near. 'soon' is under
 * 24 hours away, 'ended' is past; a record that names no end is 'open'.
 * @param {Date | null | undefined} expires
 * @param {number} now milliseconds since the epoch
 * @returns {{ state: 'open' | 'ok' | 'soon' | 'ended', left: number | null, text: string }}
 */
export function recordLife (expires, now) {
  if (!expires) return { state: 'open', left: null, text: 'no end given' }
  const left = expires.getTime() - now
  if (left <= 0) return { state: 'ended', left, text: `ended ${formatSpan(-left)} ago` }
  return { state: left < RECORD_WARN_MS ? 'soon' : 'ok', left, text: `${formatSpan(left)} left` }
}

/**
 * The provider count as a row shows it, flagged when exactly one peer announces the content.
 * @param {{ status: string, count: number }} providers
 * @returns {{ text: string, flag: 'none' | 'single' | null }}
 */
export function providersView (providers) {
  if (providers.status === 'pending') return { text: '…', flag: null }
  if (providers.status === 'skipped') return { text: 'not asked', flag: null }
  if (providers.status === 'error') return { text: 'could not ask', flag: null }
  if (providers.count === 0) return { text: 'nobody', flag: 'none' }
  if (providers.count === 1) return { text: '1 listed', flag: 'single' }
  return { text: `${providers.count} listed`, flag: null }
}

/**
 * The sentences a flagged row adds to its warnings, in the order a visitor reads the row.
 * @param {{ providers: { status: string, count: number }, record: { best: { expires?: Date | null | undefined } | null } }} row
 * @param {number} now
 * @returns {string[]}
 */
export function flagWarnings (row, now) {
  /** @type {string[]} */
  const out = []
  if (providersView(row.providers).flag === 'single') out.push('Only one provider announces this content')
  const life = row.record.best ? recordLife(row.record.best.expires, now) : null
  if (life?.state === 'soon') out.push(`The ipns:// record is valid for less than 24 hours (${life.text})`)
  return out
}

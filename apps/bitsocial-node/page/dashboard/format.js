// How the dashboard words a size, a time and a length of time.

export const REACHABILITY = { public: 'Reachable from the internet', private: 'Not reachable from the internet (behind a router)', unknown: 'Not measured yet' }

/** @param {number} bytes */
export const sizeOf = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${String(Math.round(bytes / 1e3))} kB`)

/** The units a length of time is entered in, largest first. */
export const UNITS = /** @type {const} */ ([
  { name: 'days', seconds: 86_400 },
  { name: 'hours', seconds: 3_600 },
  { name: 'minutes', seconds: 60 },
  { name: 'seconds', seconds: 1 }
])

/** The largest unit that holds `seconds` exactly: 172800 is 2 days, 5400 is 90 minutes. @param {number} seconds */
export function splitDuration (seconds) {
  const unit = UNITS.find((one) => seconds % one.seconds === 0) ?? UNITS[3]
  return { value: String(seconds / unit.seconds), unit: unit.name }
}

/** @param {string} value a whole number @param {string} unit one of UNITS' names @returns {number} */
export const toSeconds = (value, unit) => Number(value) * (UNITS.find((one) => one.name === unit)?.seconds ?? 1)

/** @param {number} seconds */
function span (seconds) {
  if (seconds < 90) return `${String(Math.max(0, Math.round(seconds)))} s`
  if (seconds < 90 * 60) return `${String(Math.round(seconds / 60))} min`
  if (seconds < 36 * 3_600) return `${String(Math.round(seconds / 3_600))} h`
  return `${String(Math.round(seconds / 86_400))} days`
}

/** "12 s ago", "5 min ago". @param {number} then @param {number} now both in milliseconds */
export const agoOf = (then, now) => (now - then < 5_000 ? 'just now' : `${span((now - then) / 1000)} ago`)

/** "in 12 s". @param {number} then @param {number} now both in milliseconds */
export const inOf = (then, now) => (then - now < 1_000 ? 'now' : `in ${span((then - now) / 1000)}`)

/** A size with its unit, down to single bytes: the seeding and bandwidth lines hold small numbers too. @param {number} bytes */
export const bytesOf = (bytes) => (bytes < 1_000 ? `${String(Math.round(bytes))} B` : sizeOf(bytes))

/** The units a space limit is entered in, with the bytes of each (decimal, as `sizeOf` shows). */
export const SIZE_UNITS = /** @type {const} */ ([
  { name: 'MB', bytes: 1e6 },
  { name: 'GB', bytes: 1e9 },
  { name: 'TB', bytes: 1e12 }
])

/** The largest unit that holds `bytes` as a whole number: 5e9 is 5 GB, 2.5e9 is 2500 MB; a size no unit holds is shown in MB with decimals. @param {number} bytes */
export function splitSize (bytes) {
  const unit = [...SIZE_UNITS].reverse().find((one) => bytes % one.bytes === 0) ?? SIZE_UNITS[0]
  return { value: String(bytes / unit.bytes), unit: unit.name }
}

/** @param {string} value a whole number @param {string} unit one of SIZE_UNITS' names @returns {number} */
export const toBytes = (value, unit) => Number(value) * (SIZE_UNITS.find((one) => one.name === unit)?.bytes ?? 1)

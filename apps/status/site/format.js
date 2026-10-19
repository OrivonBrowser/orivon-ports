// Numbers and times as a person reads them. Pure.

/** @param {number} bytes */
export function formatBytes (bytes) {
  if (bytes < 1000) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

/** @param {number} ms */
export const formatSeconds = (ms) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`

/** A UTC date and time to the minute. @param {Date} date */
export const formatDate = (date) => date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

/** The local clock, HH:MM:SS. @param {Date} date */
export function formatClock (date) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':')
}

/** "ipfs.orbitor.dev x6, ipfs.filebase.io x1" from a gateway tally. @param {Record<string, number>} tally */
export function formatGateways (tally) {
  return Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([host, count]) => `${host} ×${count}`).join(', ')
}

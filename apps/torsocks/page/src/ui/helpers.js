// Pure functions behind the interface: nothing here touches the DOM, so each one is unit-tested.
import { LIMITS } from '../model.js'

export const KIND_LABELS = Object.freeze({
  article: 'Article',
  picture: 'Picture',
  file: 'Files',
  folder: 'Folder',
  website: 'Website'
})

/** 1536 -> "1.5 KB". Binary steps, labelled the way file managers label them. */
export function humanSize (bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0
  // 1023.5 and up would print as "1024", so it moves to the next unit instead.
  while (value >= 1023.5 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 100 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function percent (frac) {
  const n = Number(frac)
  if (!Number.isFinite(n)) return 0
  return Math.round(Math.min(1, Math.max(0, n)) * 100)
}

/** "127.0.0.1:9150" once the proxy listens, '' before. */
export function formatSocks (socks) {
  if (!socks || socks.state !== 'listening' || !(socks.port > 0)) return ''
  return `${socks.host || '127.0.0.1'}:${socks.port}`
}

/** Splits an address into groups of eight so the eye can hold it. The suffix stays apart. */
export function groupOnion (onion) {
  if (typeof onion !== 'string' || onion === '') return { groups: [], suffix: '' }
  const name = onion.replace(/\.onion$/i, '')
  const groups = name.match(/.{1,8}/g) || []
  return { groups, suffix: '.onion' }
}

/** ISO date -> "YYYY-MM-DD" in UTC, or '' when it does not parse. */
export function formatDate (iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 10)
}

/** ms since the epoch -> "HH:MM:SS" in local time. */
export function formatClock (ms) {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const two = (n) => String(n).padStart(2, '0')
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

/** @returns {{ text: string, tone: 'ok' | 'busy' | 'bad' | 'idle' }} */
export function chipFor (state) {
  switch (state.phase) {
    case 'outside-orivon': return { text: 'Not in Orivon', tone: 'idle' }
    case 'checking': return { text: 'Looking for Tor…', tone: 'busy' }
    case 'starting': return { text: 'Starting Tor…', tone: 'busy' }
    case 'failed': return { text: 'Stopped', tone: 'bad' }
  }
  if (state.socks.state === 'failed') return { text: 'Proxy failed', tone: 'bad' }
  if (state.bootstrap.ready && state.socks.state === 'listening') return { text: 'Online', tone: 'ok' }
  if (state.bootstrap.ready) return { text: 'Opening the proxy…', tone: 'busy' }
  return { text: `Connecting ${percent(state.bootstrap.frac)}%`, tone: 'busy' }
}

/** @returns {{ text: string, tone: 'ok' | 'busy' | 'warn' | 'bad' | 'idle', pulse: boolean }} */
export function badgeFor (serviceState) {
  switch (serviceState) {
    case 'running': return { text: 'Online', tone: 'ok', pulse: false }
    case 'starting': return { text: 'Starting', tone: 'busy', pulse: true }
    case 'publishing': return { text: 'Publishing', tone: 'busy', pulse: true }
    case 'recovering': return { text: 'Recovering', tone: 'busy', pulse: true }
    case 'degraded': return { text: 'Degraded', tone: 'warn', pulse: false }
    case 'unreachable': return { text: 'Unreachable', tone: 'bad', pulse: false }
    case 'broken': return { text: 'Broken', tone: 'bad', pulse: false }
    case 'stopped': return { text: 'Stopped', tone: 'idle', pulse: false }
    default: return { text: 'Off', tone: 'idle', pulse: false }
  }
}

/** All / Warnings (warnings and errors) / Errors. */
export function filterLogs (logs, level) {
  if (level === 'error') return logs.filter((line) => line.level === 'ERROR')
  if (level === 'warn') return logs.filter((line) => line.level === 'WARN' || line.level === 'ERROR')
  return logs
}

export function summarizeFiles (files) {
  let bytes = 0
  for (const file of files) bytes += file.size || 0
  return { count: files.length, bytes }
}

function relativePath (file) {
  return typeof file.webkitRelativePath === 'string' ? file.webkitRelativePath : ''
}

/** Name of the folder a folder pick came from, or '' for loose files. */
export function topFolderName (files) {
  const first = files.length ? relativePath(files[0]) : ''
  return first.includes('/') ? first.split('/')[0] : ''
}

/** "holiday.photo.jpg" -> "holiday.photo"; a dotfile keeps its name. */
export function baseName (name) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * Why a pick cannot be published, or '' when it can. `kind` is the Actions kind.
 * The core checks again; this refuses early so nothing is read for nothing.
 */
export function pickProblem (kind, files, limits = LIMITS) {
  if (files.length === 0) return ''
  const { count, bytes } = summarizeFiles(files)
  if (count > limits.maxFiles) {
    return `That is ${count.toLocaleString('en-US')} files. One publication holds at most ${limits.maxFiles.toLocaleString('en-US')}.`
  }
  if (bytes > limits.maxBytes) {
    return `That is ${humanSize(bytes)}. One publication holds at most ${humanSize(limits.maxBytes)}.`
  }
  if (kind === 'picture') {
    const file = files[0]
    if (files.length > 1) return 'Choose one picture.'
    if (file.type && !file.type.startsWith('image/')) return 'That is not a picture.'
  }
  if (kind === 'folder' || kind === 'website') {
    if (!files.some((file) => relativePath(file).includes('/'))) return 'Choose a folder, not single files.'
  }
  if (kind === 'website') {
    const hasIndex = files.some((file) => {
      const parts = relativePath(file).split('/')
      return parts.length === 2 && parts[1] === 'index.html'
    })
    if (!hasIndex) return 'A website needs an index.html at the top of its folder.'
  }
  return ''
}

/** "1,234 / 200,000" and how close that is to the limit. */
export function articleCount (length, limit = LIMITS.articleLength) {
  const text = `${length.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')}`
  const tone = length > limit ? 'bad' : length >= limit * 0.9 ? 'warn' : ''
  return { text, tone }
}

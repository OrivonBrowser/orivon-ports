// How sizes, times and names read on the page. Pure.

/** Sizes are binary, as most file managers show them: 100 MiB reads "100 MB". @param {number} bytes */
export function formatBytes (bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`
  return `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 2 : 1)} GB`
}

/** "1 file", "3 files". @param {number} n @param {string} one @param {string} [many] */
export function count (n, one, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

/** "22 Nov 2026". @param {number} at */
export function formatDay (at) {
  return new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** "just now", "5 minutes ago", "yesterday", then a date. @param {number} at @param {number} [now] */
export function formatAgo (at, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return formatDay(at)
}

/** `bafybeigdy…3ehm`: enough of an address to tell two apart. @param {string} cid */
export function shortCid (cid) {
  return cid.length > 18 ? `${cid.slice(0, 10)}…${cid.slice(-6)}` : cid
}

/** The last segment of a POSIX path. @param {string} path */
export function baseName (path) {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** A file name for something saved from a title. @param {string} title @param {string} fallback */
export function fileNameFor (title, fallback) {
  const base = title.normalize('NFKD').replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-').toLowerCase()
  return base === '' ? fallback : base.slice(0, 60)
}

/** The host of an address, for a person to read. @param {string} value */
export function hostOf (value) {
  try {
    return new URL(value).host
  } catch {
    return value
  }
}

/** The folder every path starts in, or null. @param {{ path: string }[]} entries */
export function topFolder (entries) {
  const first = entries[0]?.path.split('/')[0]
  return first && entries.every((entry) => entry.path.includes('/') && entry.path.split('/')[0] === first) ? first : null
}

/** What a share is called when nobody gave it a title. @param {{ path: string }[]} entries @param {'files' | 'folder' | 'website'} kind */
export function nameOfEntries (entries, kind) {
  if (kind === 'files') return entries.length === 1 ? (entries[0]?.path ?? 'A file') : count(entries.length, 'file')
  return topFolder(entries) ?? (kind === 'website' ? 'A website' : 'A folder')
}

// How times, sizes and addresses read on the page. Pure.

/** @param {number} bytes */
export function formatBytes (bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
  return new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** `bafybeigdy…3ehm`: enough of a CID to tell two apart at a glance. @param {string} cid */
export function shortCid (cid) {
  return cid.length > 18 ? `${cid.slice(0, 10)}…${cid.slice(-6)}` : cid
}

/** The address a person reads for where a wiki came from. @param {string} url */
export function displayAddress (url) {
  try {
    const parsed = new URL(url)
    const ipfs = /^([a-z0-9]+)\.ipfs\.orivon$/.exec(parsed.hostname)
    if (ipfs) return `ipfs://${shortCid(ipfs[1])}${parsed.pathname === '/' ? '' : parsed.pathname}`
    if (parsed.protocol === 'file:') return 'a file on this computer'
    return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname)
  } catch {
    return url
  }
}

/** A file name from a wiki title. @param {string} title */
export function fileNameFor (title) {
  const base = title.normalize('NFKD').replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-').toLowerCase()
  return base === '' ? 'wiki' : base.slice(0, 60)
}

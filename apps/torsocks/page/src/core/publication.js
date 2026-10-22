// What each kind of publication becomes on disk: a list of files under the
// service's `www` directory, and whether visitors see a folder listing.
// Pure: it reads nothing and writes nothing, so every rule here is tested.
// A person-facing Error is thrown for anything that cannot be published.

import { LIMITS } from '../model.js'
import { articlePage, filesPage, picturePage } from '../ui/templates.js'
import { renderMarkdown } from './markdown.js'

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const ID_LENGTH = 12

/** A new service id: what the daemon names the service's key and directory by. */
export function newId (random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  return Array.from(random(ID_LENGTH), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('')
}

/** One path inside a publication, as segments, or null for anything that could leave it. */
export function safeSegments (path) {
  const segments = String(path).split('/')
  // eslint-disable-next-line no-control-regex
  if (segments.some((s) => s === '' || s === '.' || s === '..' || /[\\:\u0000-\u001f\u007f]/.test(s) || s.length > 255)) return null
  return segments
}

function relativePathOf (file) {
  return typeof file.webkitRelativePath === 'string' && file.webkitRelativePath !== '' ? file.webkitRelativePath : file.name
}

/** A picked folder's files at their paths inside it: the folder's own name is dropped. */
export function folderEntries (files) {
  if (files.length === 0) throw new Error('The folder is empty.')
  const tops = new Set(files.map((file) => relativePathOf(file).split('/')[0]))
  const strip = tops.size === 1 && files.every((file) => relativePathOf(file).includes('/'))
  return files.map((file) => {
    const segments = safeSegments(relativePathOf(file))
    if (segments === null) throw new Error(`"${relativePathOf(file)}" is not a name a published file can have.`)
    return { path: (strip ? segments.slice(1) : segments).join('/'), source: file, size: file.size }
  })
}

function checkTitle (title) {
  const trimmed = String(title ?? '').trim()
  if (trimmed === '') throw new Error('Give it a title.')
  if (trimmed.length > LIMITS.titleLength) throw new Error(`The title is longer than ${String(LIMITS.titleLength)} characters.`)
  return trimmed
}

function checkLimits (entries) {
  if (entries.length > LIMITS.maxFiles) throw new Error(`That is ${String(entries.length)} files; one publication holds at most ${String(LIMITS.maxFiles)}.`)
  const bytes = entries.reduce((sum, entry) => sum + entry.size, 0)
  if (bytes > LIMITS.maxBytes) throw new Error('That is more than one publication can hold (2 GB).')
  const paths = new Set()
  for (const entry of entries) {
    const key = entry.path.toLowerCase()
    if (paths.has(key)) throw new Error(`Two files would both be "${entry.path}".`)
    paths.add(key)
  }
  return bytes
}

const encoder = new TextEncoder()
const page = (path, html) => {
  const bytes = encoder.encode(html)
  return { path, source: bytes, size: bytes.length }
}

function plan (kind, title, entries, listing) {
  return { kind, title, entries, listing, bytes: checkLimits(entries), files: entries.length }
}

export function planArticle ({ title, byline, body }, now = new Date()) {
  const name = checkTitle(title)
  const text = String(body ?? '')
  if (text.trim() === '') throw new Error('Write something first.')
  if (text.length > LIMITS.articleLength) throw new Error(`The article is longer than ${String(LIMITS.articleLength)} characters.`)
  const html = articlePage({ title: name, byline: String(byline ?? '').trim(), date: now.toISOString(), bodyHtml: renderMarkdown(text) })
  return plan('article', name, [page('index.html', html)], false)
}

/** `photo.JPG` to `jpg`; a name without a plain extension gets none. */
export function extensionOf (name) {
  const match = /\.([a-z0-9]{1,5})$/i.exec(String(name))
  return match === null ? '' : match[1].toLowerCase()
}

export function planPicture ({ title, note, files }) {
  const name = checkTitle(title)
  if (files.length !== 1) throw new Error('Choose one picture.')
  const [file] = files
  if (typeof file.type === 'string' && file.type !== '' && !file.type.startsWith('image/')) throw new Error(`"${file.name}" is not a picture.`)
  const extension = extensionOf(file.name)
  const image = extension === '' ? 'picture' : `picture.${extension}`
  const html = picturePage({ title: name, note: String(note ?? '').trim(), image, alt: name })
  return plan('picture', name, [page('index.html', html), { path: image, source: file, size: file.size }], false)
}

/** `name` made unique among `taken`: `a.txt`, then `a (2).txt`. */
export function uniqueName (name, taken) {
  if (!taken.has(name.toLowerCase())) return name
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${String(n)})${ext}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

export function planFiles ({ title, note, files }) {
  const name = checkTitle(title)
  if (files.length === 0) throw new Error('Choose at least one file.')
  const taken = new Set()
  const listed = []
  const entries = []
  for (const file of files) {
    const base = String(file.name).replace(/[/\\:]/g, '_')
    if (safeSegments(base) === null) throw new Error(`"${file.name}" is not a name a published file can have.`)
    const unique = uniqueName(base, taken)
    taken.add(unique.toLowerCase())
    listed.push({ name: unique, href: `files/${encodeURIComponent(unique)}`, size: file.size })
    entries.push({ path: `files/${unique}`, source: file, size: file.size })
  }
  const html = filesPage({ title: name, note: String(note ?? '').trim(), files: listed })
  return plan('file', name, [page('index.html', html), ...entries], false)
}

export function planFolder ({ title, files }) {
  return plan('folder', checkTitle(title), folderEntries(files), true)
}

export function planWebsite ({ title, files }) {
  const entries = folderEntries(files)
  if (!entries.some((entry) => entry.path === 'index.html')) throw new Error('A website needs an index.html at the top of its folder.')
  return plan('website', checkTitle(title), entries, false)
}

/** The plan for `publishFiles`' input, by kind. */
export function planFor (input) {
  switch (input.kind) {
    case 'picture': return planPicture(input)
    case 'file': return planFiles(input)
    case 'folder': return planFolder(input)
    case 'website': return planWebsite(input)
    default: throw new Error(`Nothing publishes a "${String(input.kind)}".`)
  }
}

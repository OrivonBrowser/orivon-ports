// What a person brings becomes the tiddlers the editor keeps: a wiki its pen
// handed over, a TiddlyWiki page, a JSON file of tiddlers, or an editor backup.
// Pure, apart from the DOMParser the oldest TiddlyWiki files need.

import { parseName } from './ipfs/ipns.js'

export const LINEAGE = '$:/DecentraWiki/Lineage'
export const HANDOFF_FORMAT = 'decentrawiki-handoff'
export const BACKUP_FORMAT = 'decentrawiki-backup'

const STORE = /<script class="tiddlywiki-tiddler-store" type="application\/json">([\s\S]*?)<\/script>/g

/**
 * What the editor supplies itself, current with its own core (the core file also
 * sets the save button's template on every page it loads), what TiddlyWiki
 * reports about the browser it ran in ($:/info/), and what is only the state of
 * the page a wiki was saved from. The rest of a wiki, plugins included, comes
 * across as it is.
 */
const DROPPED = [
  /^\$:\/core$/,
  /^\$:\/boot\//,
  /^\$:\/library\//,
  /^\$:\/plugins\/orivon\/decentrawiki(?:-frame)?(?:\/|$)/,
  /^\$:\/config\/DecentraWiki\//,
  /^\$:\/DecentraWiki\/Lineage$/,
  /^\$:\/config\/SaveWikiButton\/Template$/,
  /^\$:\/themes\/tiddlywiki\/(?:vanilla|snowwhite)$/,
  /^\$:\/(?:StoryList|HistoryList|Import|isEncrypted|UploadName)$/,
  /^\$:\/(?:state|temp|status|info)\//
]

export class ImportError extends Error {
  /** @param {'encrypted' | 'not-a-wiki' | 'empty' | 'unreadable'} kind @param {string} message */
  constructor (kind, message) {
    super(message)
    this.name = 'ImportError'
    this.kind = kind
  }
}

/** @typedef {Record<string, string>} Fields */
/** @typedef {{ id: string, previous: string | null, name?: string }} Lineage `name`: the address the version was published under, when it had one. */

/** TiddlyWiki's own list syntax, for a field a file wrote as an array. @param {unknown[]} items */
function stringifyList (items) {
  return items.map((item) => {
    const text = String(item)
    return /\s/.test(text) ? `[[${text}]]` : text
  }).join(' ')
}

/** Every field a string, as TiddlyWiki stores them; anything without a title is dropped. @param {unknown} raw @returns {Fields | null} */
export function normaliseFields (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  /** @type {Fields} */
  const fields = {}
  for (const [name, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue
    fields[name] = Array.isArray(value) ? stringifyList(value) : String(value)
  }
  return typeof fields.title === 'string' && fields.title !== '' ? fields : null
}

/** @param {string} title */
export function isDropped (title) {
  return DROPPED.some((pattern) => pattern.test(title))
}

/**
 * The tiddlers of a TiddlyWiki page: the JSON stores every TiddlyWiki 5.2 and
 * later writes, else the older `#storeArea` of divs.
 * @param {string} html
 * @param {{ DOMParserImpl?: typeof DOMParser }} [options]
 * @returns {Fields[]}
 */
export function tiddlersFromHtml (html, { DOMParserImpl = globalThis.DOMParser } = {}) {
  if (/id=["']encryptedStoreArea["']/.test(html)) {
    throw new ImportError('encrypted', 'This wiki is protected by a password. Open it in TiddlyWiki, remove the password, save it and import the saved file.')
  }
  /** @type {Fields[]} */
  const tiddlers = []
  let stores = 0
  for (const match of html.matchAll(STORE)) {
    stores++
    let parsed
    try {
      parsed = JSON.parse(match[1] ?? '[]')
    } catch {
      throw new ImportError('unreadable', 'This TiddlyWiki page is damaged: one of its tiddler stores cannot be read.')
    }
    for (const raw of Array.isArray(parsed) ? parsed : []) {
      const fields = normaliseFields(raw)
      if (fields !== null) tiddlers.push(fields)
    }
  }
  if (stores === 0 && /id=["']storeArea["']/.test(html) && DOMParserImpl !== undefined) {
    const doc = new DOMParserImpl().parseFromString(html, 'text/html')
    for (const div of doc.querySelectorAll('#storeArea > div')) {
      /** @type {Record<string, string>} */
      const raw = {}
      for (const attribute of div.attributes) raw[attribute.name] = attribute.value
      raw.text = div.querySelector('pre')?.textContent ?? div.textContent ?? ''
      const fields = normaliseFields(raw)
      if (fields !== null) tiddlers.push(fields)
    }
    stores = tiddlers.length > 0 ? 1 : 0
  }
  if (stores === 0) throw new ImportError('not-a-wiki', 'This page is not a TiddlyWiki wiki, so there is nothing to import from it.')
  return tiddlers
}

/**
 * A JSON file: an array of tiddlers (TiddlyWiki's own export), a wiki its pen
 * handed over, or an editor backup holding several wikis.
 * @param {string} text
 * @returns {{ kind: 'tiddlers', tiddlers: Fields[] } | { kind: 'backup', wikis: any[] }}
 */
export function parseJson (text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ImportError('unreadable', 'This file is not valid JSON, so it holds no tiddlers to import.')
  }
  if (parsed !== null && typeof parsed === 'object' && parsed.format === BACKUP_FORMAT && Array.isArray(parsed.wikis)) {
    return { kind: 'backup', wikis: parsed.wikis }
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.format === HANDOFF_FORMAT && Array.isArray(parsed.tiddlers) ? parsed.tiddlers : null
  if (list === null) throw new ImportError('not-a-wiki', 'This JSON file holds no tiddlers.')
  /** @type {Fields[]} */
  const tiddlers = []
  for (const raw of list) {
    const fields = normaliseFields(raw)
    if (fields !== null) tiddlers.push(fields)
  }
  return { kind: 'tiddlers', tiddlers }
}

/** A wiki's address as a name, or null for anything that is not one. @param {unknown} text @returns {string | null} */
export function asName (text) {
  if (typeof text !== 'string') return null
  try {
    return parseName(text).name
  } catch {
    return null
  }
}

/** @param {Fields | undefined} tiddler @returns {Lineage | null} */
function lineageOf (tiddler) {
  if (tiddler === undefined) return null
  try {
    const parsed = JSON.parse(tiddler.text ?? '')
    if (typeof parsed?.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(parsed.id)) return null
    /** @type {Lineage} */
    const lineage = { id: parsed.id, previous: typeof parsed.previous === 'string' ? parsed.previous.slice(0, 300) : null }
    const name = asName(parsed.name)
    if (name !== null) lineage.name = name
    return lineage
  } catch {
    return null
  }
}

/** Plain text of a title tiddler, which may hold wikitext. @param {string | undefined} text */
function plain (text) {
  return (text ?? '').replace(/\[\[(?:([^|\]]*)\|)?([^\]]*)\]\]/g, (_link, shown, target) => shown ?? target).replace(/[{}<>'"`]/g, '').trim().slice(0, 120)
}

/**
 * What the editor keeps of a set of tiddlers, and what it learned from them.
 * The last of two tiddlers with one title wins, as in TiddlyWiki.
 * @param {Fields[]} raw
 */
export function prepareImport (raw) {
  /** @type {Map<string, Fields>} */
  const byTitle = new Map()
  for (const fields of raw) byTitle.set(fields.title ?? '', fields)
  const lineage = lineageOf(byTitle.get(LINEAGE))
  /** @type {Fields[]} */
  const tiddlers = []
  let dropped = 0
  let bytes = 0
  for (const [title, fields] of byTitle) {
    if (isDropped(title)) {
      dropped++
      continue
    }
    tiddlers.push(fields)
    bytes += JSON.stringify(fields).length
  }
  if (tiddlers.length === 0) throw new ImportError('empty', 'This wiki has no tiddlers of its own to edit.')
  return {
    tiddlers,
    lineage,
    title: plain(byTitle.get('$:/SiteTitle')?.text) || 'Untitled wiki',
    subtitle: plain(byTitle.get('$:/SiteSubtitle')?.text),
    count: tiddlers.filter((t) => !t.title.startsWith('$:/')).length,
    bytes,
    dropped
  }
}

/** @param {Fields} fields */
function canonical (fields) {
  return JSON.stringify(Object.keys(fields).sort().map((name) => [name, fields[name]]))
}

/**
 * How `incoming` differs from `local`, by title: the ordinary tiddlers a person
 * reads, and apart, the system tiddlers ($:/...) that set the wiki up.
 * @param {Fields[]} local
 * @param {Fields[]} incoming
 */
export function compareTiddlers (local, incoming) {
  const before = new Map(local.map((fields) => [fields.title, canonical(fields)]))
  const after = new Map(incoming.map((fields) => [fields.title, canonical(fields)]))
  /** @type {{ added: string[], changed: string[], removed: string[], system: number }} */
  const diff = { added: [], changed: [], removed: [], system: 0 }
  for (const [title, value] of after) {
    const old = before.get(title)
    const kind = old === undefined ? 'added' : old === value ? null : 'changed'
    if (kind === null) continue
    if (title.startsWith('$:/')) diff.system++
    else diff[kind].push(title)
  }
  for (const title of before.keys()) {
    if (after.has(title)) continue
    if (title.startsWith('$:/')) diff.system++
    else diff.removed.push(title)
  }
  return diff
}

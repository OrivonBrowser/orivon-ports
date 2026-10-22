// The wikis in the library: making one, taking one in, keeping its description
// in step with its tiddlers, and backing all of them up to one file.

import * as store from './store.js'
import { BACKUP_FORMAT, LINEAGE, isDropped, normaliseFields, prepareImport } from './import.js'

/** @typedef {import('./store.js').Wiki} Wiki @typedef {import('./store.js').Fields} Fields @typedef {import('./store.js').WikiSource} WikiSource */

const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="1" y="1" width="30" height="30" rx="8" fill="#4f46e5"/><path d="M9 7h9l5 5v13a1 1 0 01-1 1H9a1 1 0 01-1-1V8a1 1 0 011-1z" fill="#fff"/><path d="M18 7v5h5" fill="none" stroke="#c7d2fe" stroke-width="1.5"/><path d="M12 21.5l.6-2.8 6.6-6.6 2.2 2.2-6.6 6.6-2.8.6z" fill="#4f46e5"/></svg>'

/** A random id for a wiki, or for the family of versions a wiki belongs to. */
export function newId () {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** TiddlyWiki's own timestamp format, UTC. @param {Date} [date] */
export function twDate (date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${pad(date.getUTCMilliseconds(), 3)}`
}

/** The tiddlers a new wiki starts with. @param {string} title @param {string} subtitle */
export function starterTiddlers (title, subtitle) {
  const now = twDate()
  const stamp = { created: now, modified: now }
  return [
    { title: '$:/SiteTitle', text: title, ...stamp },
    { title: '$:/SiteSubtitle', text: subtitle, ...stamp },
    { title: '$:/DefaultTiddlers', text: '[[Welcome]]', ...stamp },
    { title: '$:/favicon.ico', type: 'image/svg+xml', text: FAVICON, ...stamp },
    {
      title: 'Welcome',
      tags: 'Start',
      ...stamp,
      text: `Welcome to //${title.replace(/[/'[\]{}<>]/g, '')}//.\n\n` +
        'Write here: press the pencil on this tiddler to change it, or the + button in the sidebar for a new one. Every change is kept in this browser as you type.\n\n' +
        "When the wiki is ready, press ''Publish'' at the top of the editor. It gets an IPFS address that anyone can open, and anyone who opens it can press the pen to edit their own copy and publish it in turn."
    }
  ]
}

/** @param {Fields[]} tiddlers */
function titlesOf (tiddlers) {
  const text = (title) => tiddlers.find((t) => t.title === title)?.text ?? ''
  return { title: text('$:/SiteTitle').trim().slice(0, 120) || 'Untitled wiki', subtitle: text('$:/SiteSubtitle').trim().slice(0, 200) }
}

/** @param {{ title: string, subtitle: string }} details @returns {Promise<Wiki>} */
export async function createWiki ({ title, subtitle }) {
  const now = Date.now()
  /** @type {Wiki} */
  const wiki = { id: newId(), title, subtitle, createdAt: now, updatedAt: now, source: { kind: 'new', at: now }, lineage: newId(), previous: null, publications: [] }
  await store.replaceTiddlers(wiki.id, starterTiddlers(title, subtitle))
  await store.putWiki(wiki)
  void store.askToPersist()
  return wiki
}

/**
 * Takes a prepared import in as a new wiki of the library.
 * @param {ReturnType<typeof prepareImport>} prepared
 * @param {WikiSource} source
 * @returns {Promise<Wiki>}
 */
export async function addImported (prepared, source) {
  const now = Date.now()
  /** @type {Wiki} */
  const wiki = {
    id: newId(),
    title: prepared.title,
    subtitle: prepared.subtitle,
    createdAt: now,
    updatedAt: now,
    source,
    lineage: prepared.lineage?.id ?? newId(),
    previous: source.address ?? null,
    publications: []
  }
  await store.replaceTiddlers(wiki.id, prepared.tiddlers)
  await store.putWiki(wiki)
  void store.askToPersist()
  return wiki
}

/**
 * Replaces a wiki's tiddlers with a newer version of it, keeping its
 * publications. @param {string} id @param {ReturnType<typeof prepareImport>} prepared @param {WikiSource} source
 */
export async function replaceWithVersion (id, prepared, source) {
  await store.replaceTiddlers(id, prepared.tiddlers)
  return await store.updateWiki(id, (wiki) => ({ ...wiki, title: prepared.title, subtitle: prepared.subtitle, updatedAt: Date.now(), source, previous: source.address ?? wiki.previous }))
}

/** The wikis of the library that are versions of one wiki. @param {string | undefined} lineage */
export async function copiesOf (lineage) {
  if (lineage === undefined) return []
  return (await store.listWikis()).filter((wiki) => wiki.lineage === lineage)
}

/**
 * Keeps what the editing frame changed, and the library card in step with it.
 * Titles the editor supplies itself never reach storage, whatever the frame sends.
 * @param {string} id @param {unknown[]} put @param {unknown[]} removed
 */
export async function keepChanges (id, put, removed) {
  /** @type {Fields[]} */
  const kept = []
  for (const raw of put) {
    const fields = normaliseFields(raw)
    if (fields !== null && !isDropped(fields.title)) kept.push(fields)
  }
  const gone = removed.filter((title) => typeof title === 'string' && !isDropped(title))
  if (kept.length === 0 && gone.length === 0) return
  await store.putTiddlers(id, kept, /** @type {string[]} */ (gone))
  const retitled = kept.some((t) => t.title === '$:/SiteTitle' || t.title === '$:/SiteSubtitle')
  const titles = retitled ? titlesOf(await store.getTiddlers(id)) : null
  await store.updateWiki(id, (wiki) => ({ ...wiki, ...(titles ?? {}), updatedAt: Date.now() }))
}

/** The tiddler a published copy carries so a later editor knows which wiki it is a version of. @param {Wiki} wiki */
export function lineageTiddler (wiki) {
  return {
    title: LINEAGE,
    type: 'application/json',
    text: JSON.stringify({ id: wiki.lineage, previous: wiki.publications.at(-1)?.cid ? `ipfs://${wiki.publications.at(-1)?.cid}` : wiki.previous })
  }
}

/** One file holding the chosen wikis, or all of them. @param {string[]} [ids] */
export async function backup (ids) {
  const wikis = (await store.listWikis()).filter((wiki) => ids === undefined || ids.includes(wiki.id))
  const entries = []
  for (const wiki of wikis) entries.push({ wiki, tiddlers: await store.getTiddlers(wiki.id) })
  return JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), wikis: entries })
}

/**
 * Takes the wikis of a backup in. A wiki already in the library under the same
 * id is left as it is, so restoring twice adds nothing. @param {any[]} entries
 * @returns {Promise<number>} how many wikis were added
 */
export async function restore (entries) {
  let added = 0
  const have = new Set((await store.listWikis()).map((wiki) => wiki.id))
  for (const entry of entries) {
    const meta = entry?.wiki
    if (typeof meta?.id !== 'string' || have.has(meta.id) || !Array.isArray(entry.tiddlers)) continue
    const prepared = prepareImport(entry.tiddlers.map(normaliseFields).filter((t) => t !== null))
    const now = Date.now()
    await store.replaceTiddlers(meta.id, prepared.tiddlers)
    await store.putWiki({
      id: meta.id,
      title: typeof meta.title === 'string' ? meta.title : prepared.title,
      subtitle: typeof meta.subtitle === 'string' ? meta.subtitle : prepared.subtitle,
      createdAt: Number(meta.createdAt) || now,
      updatedAt: Number(meta.updatedAt) || now,
      source: { kind: 'backup', at: now },
      lineage: typeof meta.lineage === 'string' ? meta.lineage : newId(),
      previous: typeof meta.previous === 'string' ? meta.previous : null,
      publications: Array.isArray(meta.publications)
        ? meta.publications.filter((p) => typeof p?.cid === 'string' && /^b[a-z2-7]{20,}$/.test(p.cid)).map((p) => ({ cid: p.cid, at: Number(p.at) || now, target: String(p.target ?? '').slice(0, 120), size: Number(p.size) || 0 }))
        : []
    })
    added++
  }
  return added
}

// Publishing a wiki: build it as a static page beside the shared TiddlyWiki
// core, compute its IPFS address here, pin it where the person chose, and
// accept the pin only when the target reports that same address. The address
// is computed from the bytes on this side, so a target cannot substitute others.

import { importDirectory } from '../ipfs/unixfs.js'
import { writeCar } from '../ipfs/car.js'
import { parseCid } from '../ipfs/cid.js'
import { lineageTiddler } from '../wikis.js'
import * as store from '../store.js'
import { pin } from './targets.js'

const VIEWER_PLUGIN = '$:/plugins/orivon/decentrawiki'
const FRAME_ONLY = ['$:/plugins/orivon/decentrawiki-frame', '$:/config/DecentraWiki/Mode']
const STORE = /<script class="tiddlywiki-tiddler-store" type="application\/json">([\s\S]*?)<\/script>/g
const BINARY_ICON = /^image\/(?:x-icon|vnd\.microsoft\.icon|png|gif|jpeg|webp)$/

/** @typedef {{ path: string, bytes: Uint8Array }} SiteFile */
/** @typedef {{ files: SiteFile[], cid: string, blocks: Map<string, Uint8Array>, size: number }} Site */

/** @param {string} html @returns {Map<string, Record<string, string>>} */
export function storeOf (html) {
  /** @type {Map<string, Record<string, string>>} */
  const tiddlers = new Map()
  for (const match of html.matchAll(STORE)) {
    for (const fields of JSON.parse(match[1] ?? '[]')) tiddlers.set(fields.title, fields)
  }
  return tiddlers
}

/** @type {Promise<{ core: string, coreBytes: Uint8Array, viewer: string }> | undefined} */
let editorFiles

/** The core file every published wiki loads, and the published-wiki plugin as this editor ships it. */
function ownFiles () {
  editorFiles ??= (async () => {
    const build = await (await fetch('build.json', { cache: 'no-cache' })).json()
    const core = String(build.core)
    if (!/^tiddlywikicore-[\d.]+\.js$/.test(core)) throw new Error('This editor is damaged: it names no TiddlyWiki core. Reload it.')
    const [coreResponse, frameResponse] = await Promise.all([fetch(core), fetch('frame.html')])
    if (!coreResponse.ok || !frameResponse.ok) throw new Error('This editor could not read its own files. Check the connection and try again.')
    const viewer = storeOf(await frameResponse.text()).get(VIEWER_PLUGIN)?.text
    if (viewer === undefined) throw new Error('This editor is damaged: its published-wiki plugin is missing. Reload it.')
    return { core, coreBytes: new Uint8Array(await coreResponse.arrayBuffer()), viewer }
  })()
  editorFiles.catch(() => { editorFiles = undefined })
  return editorFiles
}

/** @param {string} base64 */
function decodeBase64 (base64) {
  const binary = atob(base64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Checks a page the editing frame built is a published wiki this editor would
 * make: it loads the shared core, carries the published-wiki plugin exactly as
 * shipped, and none of the frame's own tiddlers.
 * @param {string} html @param {{ core: string, viewer: string }} own
 */
export function checkPublishedPage (html, own) {
  if (!html.includes(`<script src="${own.core}"`)) throw new Error('The built page does not load the TiddlyWiki core this editor publishes with.')
  const tiddlers = storeOf(html)
  if (tiddlers.get(VIEWER_PLUGIN)?.text !== own.viewer) throw new Error('A plugin in this wiki changed the DecentraWiki pen. Remove the plugin that replaces $:/plugins/orivon/decentrawiki and publish again.')
  for (const title of FRAME_ONLY) {
    if (tiddlers.has(title)) throw new Error('The built page carries the editor\'s own settings, so it was not published. Reload the editor and try again.')
  }
  return tiddlers
}

/**
 * The files of the published copy of the wiki open in `workspace`.
 * @param {import('../workspace.js').Workspace} workspace
 * @param {import('../store.js').Wiki} wiki
 * @returns {Promise<SiteFile[]>}
 */
export async function renderSite (workspace, wiki) {
  await workspace.settled()
  const own = await ownFiles()
  const { html, favicon } = await workspace.render([lineageTiddler(wiki)])
  checkPublishedPage(html, own)
  /** @type {SiteFile[]} */
  const files = [
    { path: 'index.html', bytes: new TextEncoder().encode(html) },
    { path: own.core, bytes: own.coreBytes }
  ]
  if (favicon !== null && BINARY_ICON.test(favicon.type) && favicon.text !== '') {
    try {
      files.push({ path: 'favicon.ico', bytes: decodeBase64(favicon.text) })
    } catch {
      // A damaged icon only costs the address bar its icon; the page sets one itself as it starts.
    }
  }
  return files
}

/** The directory's IPFS address and blocks, exactly as `ipfs add -r --cid-version=1` makes them. @param {SiteFile[]} files @returns {Promise<Site>} */
export async function addressSite (files) {
  const { cid, blocks, size } = await importDirectory(files)
  return { files, cid, blocks, size }
}

/** @param {string} cid */
function normalCid (cid) {
  return parseCid(cid.trim()).string
}

/**
 * Pins a built site and records the publication. `targetName` names the target in the record, given
 * the time it keeps the site until, when it says.
 * @param {import('../store.js').Wiki} wiki
 * @param {import('./targets.js').Target} target
 * @param {Site} site
 * @param {{ signal?: AbortSignal, targetName: (keptUntil: number | null) => string, onStep?: (text: string) => void }} options
 */
export async function pinSite (wiki, target, site, { signal, targetName, onStep }) {
  const { cid: reported, keptUntil } = await pin(target, {
    rootName: 'wiki', name: `${wiki.title} (DecentraWiki)`, files: site.files, site: { cid: site.cid, car: () => carOf(site) },
    ...(signal ? { signal } : {}), ...(onStep ? { onStep } : {})
  })
  let reportedCid
  try {
    reportedCid = normalCid(reported)
  } catch {
    throw new MismatchError(site.cid, reported)
  }
  if (reportedCid !== site.cid) throw new MismatchError(site.cid, reportedCid)
  const updated = await recordPublication(wiki.id, { cid: site.cid, at: Date.now(), target: targetName(keptUntil), size: site.size })
  return { updated, keptUntil }
}

/** @param {string} wikiId @param {import('../store.js').Publication} publication */
export async function recordPublication (wikiId, publication) {
  return await store.updateWiki(wikiId, (current) => ({ ...current, publications: [...current.publications, publication] }))
}

/** @param {Site} site */
export function carOf (site) {
  return writeCar(site.cid, site.blocks)
}

export class MismatchError extends Error {
  /** @param {string} expected @param {string} reported */
  constructor (expected, reported) {
    super(`The service stored something other than this wiki: it reports ${reported}, and this wiki is ${expected}. Nothing was recorded as published.`)
    this.name = 'MismatchError'
  }
}

/**
 * Addresses a published wiki opens at: its own, and the public subdomain gateway, which gives each wiki an origin
 * of its own. Some gateways refuse to show a whole TiddlyWiki page, though they serve its blocks.
 * @param {string} cid
 */
export function addressesOf (cid) {
  return {
    ipfs: `ipfs://${cid}/`,
    gateway: `https://${cid}.ipfs.dweb.link/`
  }
}

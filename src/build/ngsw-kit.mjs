// What an Angular port with a service worker repeats. Angular's service worker builder
// (`@angular/service-worker`, switched on by `serviceWorker` in a configuration of
// angular.json) writes `ngsw.json`, and two things in it do not survive being a port:
//
// - `timestamp` is `Date.now()`, the one value of the build that comes from the clock. Nothing
//   reads it but the worker's debug page, so `pinNgswTimestamp` sets it from the pinned commit's
//   date and a rebuild of the pin is the same bytes. It runs as a `build.also` step.
// - `hashTable` holds the sha1 of every file the worker caches, and the worker refuses the whole
//   app version when a fetched file hashes differently ("Hash mismatch", driver state
//   EXISTING_CLIENTS_ONLY): the app still opens online and never starts offline. A port edits
//   `index.html` after the builder ran (its hook, the icon link, the hint, the bridge script), and
//   adds files the page loads that no asset group names, so `refreshNgswHashes` makes the manifest
//   agree with the prepared tree, as the last step before the tree is hashed.
//
// ES module, run by an app's `build.also` step through a config file beside its recipe
// (`node {recipe}/ngsw.orivon.config.mjs <output>`, with the app's clone as its working directory),
// and from the app's hooks file (`finishTree`, docs/recipe-format.md).

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

const TIMESTAMP = /("timestamp"\s*:\s*)(\d+)/g

/**
 * The committer date of the commit checked out in `cwd`, in milliseconds: what `Date.now()` would have been at that
 * commit. `cwd` must be the clone itself: a folder inside some other repository would be given that repository's
 * date, and a pin that quietly follows another checkout is the clock again.
 */
export function commitTimeMs (cwd) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  if (git('rev-parse', '--show-prefix') !== '') throw new Error(`${cwd} is inside a repository, not the root of the app's clone: run this from the clone`)
  const seconds = git('log', '-1', '--format=%ct', 'HEAD')
  if (!/^\d+$/.test(seconds) || Number(seconds) === 0) {
    throw new Error(`${cwd} has no commit date to pin the service worker's timestamp to (git log printed ${JSON.stringify(seconds)})`)
  }
  return Number(seconds) * 1000
}

/**
 * `text`, a service worker manifest, with its top-level `timestamp` set to `timestamp` and every other byte as it
 * was. Throws unless the manifest parses, carries a numeric `timestamp`, and names that number in exactly one
 * place: a builder that moved or renamed the field, or an `appData` holding the same number, is a shape this does
 * not know how to edit without guessing.
 */
export function withTimestamp (text, timestamp) {
  let manifest
  try { manifest = JSON.parse(text) } catch (error) { throw new Error(`ngsw.json is not JSON: ${error instanceof Error ? error.message : String(error)}`) }
  const current = manifest?.timestamp
  if (!Number.isSafeInteger(current)) throw new Error(`ngsw.json has no numeric timestamp (found ${JSON.stringify(current)}): the service worker builder changed shape`)
  const places = [...text.matchAll(TIMESTAMP)].filter((found) => Number(found[2]) === current)
  if (places.length !== 1) throw new Error(`ngsw.json names its timestamp ${String(current)} in ${String(places.length)} places, not one: the service worker builder changed shape`)
  return text.replace(TIMESTAMP, (found, key, value) => (Number(value) === current ? `${key}${String(timestamp)}` : found))
}

/**
 * Sets `ngsw.json`'s timestamp in the build output `outputDir` (relative to `cwd`, the clone) to the pinned
 * commit's date, and returns it. Throws when the output has no `ngsw.json`: the build no longer has a service
 * worker, and the step that pins it should go.
 */
export async function pinNgswTimestamp (outputDir, { cwd = process.cwd(), timestamp = commitTimeMs(cwd) } = {}) {
  if (typeof outputDir !== 'string' || outputDir === '') throw new Error('pinNgswTimestamp needs the build output directory, relative to the clone')
  const file = join(cwd, outputDir, 'ngsw.json')
  let text
  try { text = await readFile(file, 'utf8') } catch { throw new Error(`${file} does not exist: the build wrote no service worker manifest, so there is no timestamp to pin (drop this build.also step if the service worker is gone)`) }
  const pinned = withTimestamp(text, timestamp)
  if (pinned !== text) await writeFile(file, pinned)
  return timestamp
}

/** The hash `ngsw-worker.js` compares a fetched file with: the sha1 of its bytes, in lower-case hex. */
export function sha1Hex (bytes) {
  return createHash('sha1').update(bytes).digest('hex')
}

/** The name of the asset group `refreshNgswHashes` adds for the folders it is asked to cache. */
export const PORT_GROUP = 'orivon'

/** The file in `dir` that a `hashTable` key (a path from the site root, as the worker asks for it) stands for. */
function fileOf (dir, url) {
  if (!url.startsWith('/')) throw new Error(`ngsw.json hashTable key ${JSON.stringify(url)} is not a path from the site root: the service worker builder changed shape`)
  const path = join(dir, url.slice(1))
  const inside = relative(dir, path)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside) || inside.split(sep).includes('..')) throw new Error(`ngsw.json hashTable key ${JSON.stringify(url)} leaves the served tree`)
  return path
}

/** Every file under `folder` of `dir`, as the paths from the site root the worker asks for, in a fixed order. */
async function urlsUnder (dir, folder) {
  /** @type {string[]} */
  const found = []
  let entries
  try { entries = await readdir(join(dir, folder), { recursive: true, withFileTypes: true }) } catch { throw new Error(`the tree has no folder ${folder} to add to the service worker's cache`) }
  for (const entry of entries) {
    if (entry.isFile()) found.push(`/${relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/')}`)
  }
  return found.sort()
}

/**
 * Makes `ngsw.json` in the prepared tree `dir` agree with the tree, as the last step before the tree is hashed.
 *
 * - Every `hashTable` entry is set to the sha1 of the file as it is served. The worker checks each file it caches
 *   against that table and refuses the whole app version on a difference, and a port edits `index.html` after the
 *   builder wrote the table.
 * - Every file under each of `cacheFolders` (paths from the site root, such as `orivon`) that the table does not
 *   list is added to it and to one prefetch group, `PORT_GROUP`. The builder's groups name only the app's own
 *   files, so a script or stylesheet the port's page loads from there would otherwise be fetched from the network
 *   on every start, and fail offline. The group goes first: the worker gives a request to the first group that
 *   handles it, and a lazy group's pattern (every `.png`, in Super Productivity's) would take the request of an
 *   image the group has cached.
 *
 * Returns what it did: `rehashed` (the table paths whose hash changed) and `cached` (the paths added). Throws when
 * the tree has no `ngsw.json`, when the manifest has no `hashTable` or `assetGroups`, and when it lists a file the
 * tree does not hold (the worker would refuse that version too).
 *
 * @param {string} dir
 * @param {{ cacheFolders?: string[] }} [options]
 * @returns {Promise<{ rehashed: string[], cached: string[] }>}
 */
export async function refreshNgswHashes (dir, { cacheFolders = [] } = {}) {
  const file = join(dir, 'ngsw.json')
  let text
  try { text = await readFile(file, 'utf8') } catch { throw new Error(`${file} does not exist: the tree has no service worker manifest to refresh (drop the hook that calls this if the service worker is gone)`) }
  let manifest
  try { manifest = JSON.parse(text) } catch (error) { throw new Error(`ngsw.json is not JSON: ${error instanceof Error ? error.message : String(error)}`) }
  const table = manifest?.hashTable
  if (table === null || typeof table !== 'object' || Array.isArray(table)) throw new Error('ngsw.json has no hashTable object: the service worker builder changed shape')
  if (!Array.isArray(manifest.assetGroups)) throw new Error('ngsw.json has no assetGroups list: the service worker builder changed shape')
  /** @type {string[]} */
  const rehashed = []
  for (const [url, expected] of Object.entries(table)) {
    const path = fileOf(dir, url)
    let bytes
    try { bytes = await readFile(path) } catch { throw new Error(`ngsw.json lists ${url} but the tree holds no such file: the worker would refuse this version`) }
    const actual = sha1Hex(bytes)
    if (actual !== expected) { table[url] = actual; rehashed.push(url) }
  }
  /** @type {string[]} */
  const cached = []
  for (const folder of cacheFolders) {
    for (const url of await urlsUnder(dir, folder)) {
      if (table[url] !== undefined) continue
      table[url] = sha1Hex(await readFile(fileOf(dir, url)))
      cached.push(url)
    }
  }
  if (cached.length > 0) {
    let group = manifest.assetGroups.find((candidate) => candidate?.name === PORT_GROUP)
    if (group === undefined) {
      group = { name: PORT_GROUP, installMode: 'prefetch', updateMode: 'prefetch', cacheQueryOptions: { ignoreVary: true }, urls: [], patterns: [] }
      manifest.assetGroups.unshift(group)
    }
    group.urls = [...group.urls, ...cached].sort()
  }
  if (rehashed.length > 0 || cached.length > 0) await writeFile(file, JSON.stringify(manifest, null, 2) + (text.endsWith('\n') ? '\n' : ''))
  return { rehashed, cached }
}

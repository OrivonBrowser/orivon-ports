// What an Angular port's build repeats: Angular's service worker builder
// (`@angular/service-worker`, switched on by `serviceWorker` in a configuration of
// angular.json) writes `ngsw.json` with `timestamp: Date.now()`, the one value of the
// build that comes from the clock. Nothing reads it but the worker's debug page, and
// nothing else in the file is derived from it (`hashTable` holds the files' own hashes),
// so `pinNgswTimestamp` sets it from the pinned commit's date and a rebuild of the
// pin is the same bytes.
//
// ES module, run by an app's `build.also` step through a config file beside its recipe
// (`node {recipe}/ngsw.orivon.config.mjs <output>`): the step runs with the app's clone
// as its working directory.

import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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

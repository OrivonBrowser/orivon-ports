import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { declareBundle, manifestFileOf } from './declare.ts'
import type { Declared } from './declare.ts'
import { compareVersions, firstBuild, parseVersion, raiseBuild, withVersion } from './version.ts'

// What `orivon-port release` keeps in `apps/<app>/published.json`: the version
// an app was last published at, and a hash of what was published with that
// version taken out (declare.ts `contentHash`). The browser calls a republish
// an update only when the manifest's version is higher, so publishing the same
// bytes keeps its version and publishing different bytes must raise it; the
// record is how the two are told apart without asking the network.

export const RECORD_FILE = 'published.json'

const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/
const FULL_SHA = /^[0-9a-f]{40}$/
const RECORD_KEYS = ['version', 'contentHash', 'upstreamRef']

export interface PublishedRecord {
  readonly version: string
  /** Absent in a record written before any hash was taken: every build then counts as changed, once. */
  readonly contentHash?: string
  /** The upstream commit the published build was made from. Ports only; it tells a new upstream release from a new build of the same one. */
  readonly upstreamRef?: string
}

/** What is wrong with a parsed record, or undefined. */
export function recordProblem (value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'is not a JSON object'
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) if (!RECORD_KEYS.includes(key)) return `has an unknown field "${key}" (known: ${RECORD_KEYS.join(', ')})`
  const version = record['version']
  if (typeof version !== 'string' || parseVersion(version) === undefined) return '"version" must be numbers separated by dots, e.g. "0.24.0.2"'
  const hash = record['contentHash']
  if (hash !== undefined && (typeof hash !== 'string' || !CONTENT_HASH.test(hash))) return '"contentHash" must be "sha256:" and 64 hex digits, or absent'
  const ref = record['upstreamRef']
  if (ref !== undefined && (typeof ref !== 'string' || !FULL_SHA.test(ref))) return '"upstreamRef" must be a full 40-character commit sha, or absent'
  return undefined
}

/** The app's record, undefined when it has none (never published), or an error naming the file when it is unusable. */
export async function readRecord (appDir: string): Promise<PublishedRecord | undefined> {
  const path = join(appDir, RECORD_FILE)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path} is not JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  const problem = recordProblem(parsed)
  if (problem !== undefined) throw new Error(`${path} ${problem}`)
  return parsed as PublishedRecord
}

async function writeRecord (appDir: string, record: PublishedRecord): Promise<void> {
  const ordered = { version: record.version, ...record.contentHash === undefined ? {} : { contentHash: record.contentHash }, ...record.upstreamRef === undefined ? {} : { upstreamRef: record.upstreamRef } }
  await writeFile(join(appDir, RECORD_FILE), `${JSON.stringify(ordered, null, 2)}\n`)
}

async function manifestVersion (file: string): Promise<string> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { version?: unknown }
  if (typeof parsed.version !== 'string' || parseVersion(parsed.version) === undefined) {
    throw new Error(`${file}: "version" must be numbers separated by dots, e.g. "0.24.0.2"`)
  }
  return parsed.version
}

/**
 * Why a built tree may not be published, or undefined when it may. The tree
 * must carry the recorded version if it is the recorded content, and a higher
 * one if it is anything else.
 */
export function publishProblem (id: string, record: PublishedRecord, builtVersion: string, contentHash: string): string | undefined {
  const fix = `run \`orivon-port release ${id}\``
  if (record.contentHash === contentHash) {
    return builtVersion === record.version
      ? undefined
      : `[${id}] this is the content published as ${record.version}, but the tree says ${builtVersion} -- ${fix}, which brings the tree to ${record.version}`
  }
  return compareVersions(builtVersion, record.version) > 0
    ? undefined
    : `[${id}] this differs from what was published as ${record.version} but still says ${builtVersion}, so Orivon would offer it as an unverified update -- ${fix}`
}

export interface ReleaseTarget {
  readonly id: string
  /** The app's directory: its manifest and its record. */
  readonly appDir: string
  /** The manifest's file name inside it (the recipe's `manifest`). */
  readonly manifest: string
  /** The built, declared tree. */
  readonly tree: string
  /** The recipe's pinned upstream commit; absent for an app written here. */
  readonly upstreamRef?: string
}

export interface Released {
  readonly changed: boolean
  readonly version: string
  /** The version the record held before, absent when there was none. */
  readonly previous?: string
  readonly bundleHash: string
}

/** The built manifest with `version` set and `source` dropped (the checkout is no longer at the commit it names), then the tree declared again. */
async function restamp (tree: string, id: string, version: string): Promise<Declared> {
  const file = join(tree, await manifestFileOf(tree, id))
  const { source: _source, ...manifest } = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  await writeFile(file, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`)
  return declareBundle(tree, { check: false, label: id })
}

/**
 * Decides whether a built tree is a new build of the app, and when it is,
 * raises the version in the app's manifest, in the built tree, and in the
 * record. Changes nothing for the content that was last published.
 */
export async function releaseTree (target: ReleaseTarget): Promise<Released> {
  const { id, appDir, tree } = target
  const record = await readRecord(appDir)
  const declared = await declareBundle(tree, { check: true, label: id })
  const manifestFile = join(appDir, target.manifest)
  const manifestText = await readFile(manifestFile, 'utf8')
  const current = await manifestVersion(manifestFile)

  if (record?.contentHash === declared.contentHash) {
    if (current !== record.version) {
      throw new Error(`[${id}] ${target.manifest} says ${current}, but these bytes were published as ${record.version} -- set it back to ${record.version} (nothing changed since, so the number must not move)`)
    }
    const built = await manifestVersion(join(tree, await manifestFileOf(tree, id)))
    if (built !== current) throw new Error(`[${id}] the built tree says ${built} but ${target.manifest} says ${current} -- build it again (\`orivon-port build ${id}\`), then release`)
    return { changed: false, version: current, previous: record.version, bundleHash: declared.bundleHash }
  }

  if (record !== undefined && compareVersions(current, record.version) < 0) {
    throw new Error(`[${id}] ${target.manifest} says ${current}, below the ${record.version} already published -- versions only go up`)
  }
  const pinMoved = record?.upstreamRef !== undefined && target.upstreamRef !== undefined && record.upstreamRef !== target.upstreamRef
  if (pinMoved && current === record.version) {
    throw new Error(`[${id}] the recipe's pin moved to a new upstream release since ${record.version} was published -- set "version" in ${target.manifest} to that release's own version (e.g. "1.12.33", no build number), then release again, which makes it 1.12.33.1`)
  }
  const version = pinMoved ? firstBuild(current) : raiseBuild(current)

  const redeclared = await restamp(tree, id, version)
  if (redeclared.contentHash !== declared.contentHash) {
    throw new Error(`[${id}] raising the version changed the tree's content hash -- the hash is meant to ignore it, so something else in the tree carries the version; ${target.manifest} and the record are untouched, build the tree again`)
  }
  await writeFile(manifestFile, withVersion(manifestText, version))
  await writeRecord(appDir, { version, contentHash: declared.contentHash, ...target.upstreamRef === undefined ? {} : { upstreamRef: target.upstreamRef } })
  return { changed: true, version, ...record === undefined ? {} : { previous: record.version }, bundleHash: redeclared.bundleHash }
}

/**
 * Refuses a tree that is an app's with a version that does not go with its
 * content (`publishProblem`). A tree of an app with no record, or of no app
 * here, is not this check's to judge. `appDirOf` gives the directory of a
 * known app id.
 */
export async function assertReleased (tree: string, declared: Declared, appDirOf: (id: string) => string | undefined): Promise<void> {
  const built = JSON.parse(await readFile(join(tree, await manifestFileOf(tree)), 'utf8')) as { id?: unknown, version?: unknown }
  if (typeof built.id !== 'string' || typeof built.version !== 'string') return
  const appDir = appDirOf(built.id)
  const record = appDir === undefined ? undefined : await readRecord(appDir)
  if (record === undefined || parseVersion(built.version) === undefined) return
  const problem = publishProblem(built.id, record, built.version, declared.contentHash)
  if (problem !== undefined) throw new Error(`${problem}\n(--unreleased skips this check for a tree that is not going to be published)`)
}

/** What is wrong between an app's record and the version its manifest says, or undefined. The record is what was published, so the manifest may equal it or be ahead, never behind. */
export function versionProblem (id: string, record: PublishedRecord, manifestVersion: unknown): string | undefined {
  if (typeof manifestVersion !== 'string' || parseVersion(manifestVersion) === undefined) {
    return `apps/${id}: the manifest's "version" must be numbers separated by dots, e.g. "0.24.0.2"`
  }
  return compareVersions(manifestVersion, record.version) < 0
    ? `apps/${id}: the manifest says ${manifestVersion}, below ${record.version}, the version ${RECORD_FILE} says was published -- versions only go up`
    : undefined
}

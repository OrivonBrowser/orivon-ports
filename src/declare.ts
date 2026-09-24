import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  DDOC_PATH, MANIFEST_PATH, MAX_ASSET_BYTES, MAX_BUNDLE_BYTES, MAX_BUNDLE_ENTRIES,
  bundleRoot, canonicalPathOf, compareUtf8, findCollision, leafOf, leafOfFile
} from './bundle-hash.ts'
import type { Leaf } from './bundle-hash.ts'

// Declaring a prepared tree: the manifest's `assets` list, generated from the
// files actually there, and `.well-known/orivon-ddoc.json`, the bundle hash
// and every leaf it was built from. The client fetches what `assets` names,
// re-hashes it and compares against the ddoc file, so both are written from
// one walk of one tree and neither is ever edited by hand. `check` recomputes
// both and fails on any byte of difference, which is how a file changed after
// preparing is caught before a host serves it. src/README.md's Design notes
// say why the paths are escaped the way they are.

export const MANIFEST = join('.well-known', 'orivon.json')
export const DDOC = join('.well-known', 'orivon-ddoc.json')

// The client's own bound (orivon-mvp src/loader/manifest.ts): one 64-byte
// line for each of the 4094 assets a bundle can hold, plus 16 KiB for the rest.
export const MAX_MANIFEST_BYTES = (MAX_BUNDLE_ENTRIES - 2) * 64 + 16 * 1024

export interface DeclareOptions {
  readonly check: boolean
  /** What every message is prefixed with: an app id, or the folder when absent. */
  readonly label?: string
}

export interface Declared {
  readonly bundleHash: string
  readonly files: number
  readonly manifestBytes: number
}

interface Asset {
  readonly path: string
  readonly file: string
  readonly size: number
}

function listed (lines: readonly string[]): string[] {
  const shown = lines.slice(0, 5).map((line) => `  ${line}`)
  if (lines.length > shown.length) shown.push(`  ...and ${String(lines.length - shown.length)} more`)
  return shown
}

async function readManifest (root: string, label: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(join(root, MANIFEST), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw new Error(`[${label}] ${root} has no ${MANIFEST}, so it is not a prepared tree -- \`orivon-port build <app>\` prepares one`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`[${label}] ${MANIFEST} is not JSON (${error instanceof Error ? error.message : String(error)}) -- fix the app's orivon.json and prepare it again`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`[${label}] ${MANIFEST} is not a JSON object -- fix the app's orivon.json and prepare it again`)
  }
  return parsed as Record<string, unknown>
}

/**
 * Every file under `root`, relative to it. A symbolic link is refused rather
 * than skipped or followed: a host serves it as its target or not at all, so
 * either choice here would declare a tree that is not the one served.
 */
async function listFiles (root: string, label: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue
    const path = relative(root, join(entry.parentPath, entry.name))
    if (entry.isSymbolicLink()) {
      throw new Error(`[${label}] ${path} is a symbolic link, which a static host serves as its target or not at all -- copy the file it points to into the tree instead`)
    }
    if (!entry.isFile()) throw new Error(`[${label}] ${path} is neither a file nor a directory -- a static host cannot serve it; remove it from the output`)
    files.push(path)
  }
  return files.sort(compareUtf8)
}

/** Where the client looks for the entry: resolved against the app's root, as a URL. */
function entryPath (entry: unknown, label: string): string {
  const fix = 'set "entry" in the app\'s orivon.json to the entry document, relative to the root, e.g. "index.html"'
  if (typeof entry !== 'string' || entry.length === 0 || entry.startsWith('/')) {
    throw new Error(`[${label}] ${MANIFEST} has no usable "entry" -- ${fix}`)
  }
  try {
    return new URL(entry, 'https://canonicalisation.invalid/').pathname
  } catch {
    throw new Error(`[${label}] the manifest's entry ${JSON.stringify(entry)} is not a URL path -- ${fix}`)
  }
}

function canonicalAssets (files: readonly string[], label: string): Array<Omit<Asset, 'size'>> {
  const assets: Array<Omit<Asset, 'size'>> = []
  const refused: string[] = []
  for (const file of files) {
    const canonical = canonicalPathOf(file)
    if (canonical.ok) assets.push({ path: canonical.path, file })
    else refused.push(`${file}: ${canonical.problem}`)
  }
  if (refused.length > 0) {
    throw new Error([
      `[${label}] ${String(refused.length)} file name(s) the Orivon client refuses on every platform:`,
      ...listed(refused),
      'Rename each in the build output (or the recipe\'s extraFiles), or the app cannot be pinned anywhere.'
    ].join('\n'))
  }
  return assets
}

function assertNoCollision (assets: ReadonlyArray<Omit<Asset, 'size'>>, label: string): void {
  const names = new Map<string, string>([[MANIFEST_PATH, MANIFEST], [DDOC_PATH, DDOC], ...assets.map((asset): [string, string] => [asset.path, asset.file])])
  const collision = findCollision([...names.keys()])
  if (collision === null) return
  const [a, b] = collision.map((path) => names.get(path) ?? path)
  throw new Error(`[${label}] ${String(a)} and ${String(b)} are one file on a case-insensitive or Unicode-normalising disk (Windows, macOS), and the client refuses the bundle everywhere -- rename one of them`)
}

async function measure (root: string, assets: ReadonlyArray<Omit<Asset, 'size'>>, label: string): Promise<Asset[]> {
  const sized: Asset[] = []
  for (const asset of assets) {
    const { size } = await stat(join(root, asset.file))
    if (size > MAX_ASSET_BYTES) {
      throw new Error(`[${label}] ${asset.file} is ${String(size)} bytes, over the client's ${String(MAX_ASSET_BYTES)}-byte limit for one file -- split it, or leave it out of the served tree`)
    }
    sized.push({ ...asset, size })
  }
  return sized
}

/** The manifest with `assets` right after `entry`, every other key where it was. `[]` is omitted: the client refuses it. */
function withAssets (manifest: Record<string, unknown>, assets: readonly string[]): Buffer {
  const entries: Array<[string, unknown]> = []
  for (const [key, value] of Object.entries(manifest)) {
    if (key === 'assets') continue
    entries.push([key, value])
    if (key === 'entry' && assets.length > 0) entries.push(['assets', assets])
  }
  return Buffer.from(`${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`, 'utf8')
}

async function sameBytes (file: string, bytes: Buffer): Promise<boolean> {
  try {
    return (await readFile(file)).equals(bytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function declareBundle (root: string, options: DeclareOptions): Promise<Declared> {
  const label = options.label ?? root
  const manifest = await readManifest(root, label)
  const entry = entryPath(manifest['entry'], label)

  const files = (await listFiles(root, label)).filter((file) => file !== MANIFEST && file !== DDOC)
  if (files.length + 1 > MAX_BUNDLE_ENTRIES) {
    throw new Error(`[${label}] ${String(files.length + 1)} files including the manifest, over the client's limit of ${String(MAX_BUNDLE_ENTRIES)} -- trim the build output`)
  }
  const named = canonicalAssets(files, label)
  if (!named.some((asset) => asset.path === entry)) {
    throw new Error(`[${label}] the manifest's entry ${JSON.stringify(manifest['entry'])} names no file in ${root} -- point "entry" in the app's orivon.json at the document the build emits`)
  }
  assertNoCollision(named, label)
  const assets = await measure(root, named, label)

  const listedAssets = assets.filter((asset) => asset.path !== entry).map((asset) => asset.path.slice(1)).sort(compareUtf8)
  const manifestBytes = withAssets(manifest, listedAssets)
  if (manifestBytes.length > MAX_MANIFEST_BYTES) {
    throw new Error(`[${label}] the generated manifest is ${String(manifestBytes.length)} bytes, over the client's limit of ${String(MAX_MANIFEST_BYTES)} -- fewer files, or shorter names, in the build output`)
  }
  const total = assets.reduce((sum, asset) => sum + asset.size, manifestBytes.length)
  if (total > MAX_BUNDLE_BYTES) {
    throw new Error(`[${label}] the tree is ${String(total)} bytes, over the client's ${String(MAX_BUNDLE_BYTES)}-byte limit for one app -- trim the build output`)
  }

  const leaves: Leaf[] = [{ path: MANIFEST_PATH, leaf: leafOf(MANIFEST_PATH, manifestBytes) }]
  for (const asset of assets) leaves.push({ path: asset.path, leaf: await leafOfFile(asset.path, join(root, asset.file), asset.size) })
  const tree = bundleRoot(leaves)
  const ddoc = Buffer.from(`${JSON.stringify({ bundleHash: tree.root, leaves: Object.fromEntries(tree.leaves.map(({ path, leaf }) => [path, leaf])) }, null, 2)}\n`, 'utf8')

  if (options.check) {
    const stale: string[] = []
    if (!await sameBytes(join(root, MANIFEST), manifestBytes)) stale.push(MANIFEST)
    if (!await sameBytes(join(root, DDOC), ddoc)) stale.push(DDOC)
    if (stale.length > 0) {
      throw new Error(`[${label}] ${stale.join(' and ')} no longer match(es) the files in ${root} -- something changed after the tree was declared; prepare the app again, or \`orivon-port hash <dir>\` to redeclare it as it is`)
    }
  } else {
    await writeFile(join(root, MANIFEST), manifestBytes)
    await writeFile(join(root, DDOC), ddoc)
  }
  return { bundleHash: tree.root, files: leaves.length, manifestBytes: manifestBytes.length }
}

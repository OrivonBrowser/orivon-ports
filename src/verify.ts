import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPFS_ADD_FLAGS, cidOfTree, IpfsMissingError, kuboVersion } from './ipfs-add.ts'
import { DDOC, MANIFEST, WEBSITE_MANIFEST } from './declare.ts'

// `verify` answers one question: is the tree published under an app's name the
// tree this repository builds from the commit the tree says it was built at?
// The comparing and the printing are pure; fetching the published files and
// rebuilding are passed in, so the tests cover the answer without a network.

/** Where this repository lives, for a commit the local checkout does not hold. */
export const PORTS_REPO_URL = 'https://github.com/OrivonBrowser/orivon-ports.git'

export interface Declaration {
  readonly bundleHash: string
  /** Path to leaf hash, as `.well-known/orivon-ddoc.json` lists them. */
  readonly leaves: Readonly<Record<string, string>>
}

export interface Published extends Declaration {
  /** The orivon-ports commit the manifest says built it, when it says. */
  readonly portsCommit?: string
  /** The root CID the serving gateway named, when it did or the caller gave one. */
  readonly cid?: string
}

export interface Rebuilt extends Declaration {
  readonly cid?: string
  readonly cidNote?: string
}

export interface FileDifferences {
  readonly changed: readonly string[]
  readonly onlyPublished: readonly string[]
  readonly onlyRebuilt: readonly string[]
}

export interface Comparison {
  readonly match: boolean
  readonly bundleHash: { readonly published: string, readonly rebuilt: string }
  readonly files: FileDifferences
  /** `match` is undefined unless both CIDs are known. */
  readonly cid: { readonly published?: string, readonly rebuilt?: string, readonly match?: boolean }
}

const FULL_SHA = /^[0-9a-f]{40}$/
const CID_TEXT = /^[a-z0-9]{40,}$/i

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson (text: string, what: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`the published ${what} is not JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (!isRecord(parsed)) throw new Error(`the published ${what} is not a JSON object`)
  return parsed
}

/** The two published files, read: the bundle hash and leaves from the ddoc file, the building commit from the manifest. */
export function parsePublished (manifestText: string, ddocText: string, cid?: string): Published {
  const manifest = parseJson(manifestText, 'manifest')
  const ddoc = parseJson(ddocText, 'ddoc file')
  const bundleHash = ddoc['bundleHash']
  const leaves = ddoc['leaves']
  if (typeof bundleHash !== 'string' || !isRecord(leaves)) throw new Error('the published ddoc file has no bundleHash and leaves')
  const source = manifest['source']
  const commit = isRecord(source) ? source['portsCommit'] : undefined
  return {
    bundleHash,
    leaves: Object.fromEntries(Object.entries(leaves).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    ...(typeof commit === 'string' && FULL_SHA.test(commit) ? { portsCommit: commit } : {}),
    ...(cid !== undefined && CID_TEXT.test(cid) ? { cid } : {})
  }
}

export function compare (published: Published, rebuilt: Rebuilt): Comparison {
  const changed: string[] = []
  const onlyPublished: string[] = []
  const onlyRebuilt: string[] = []
  for (const [path, leaf] of Object.entries(published.leaves)) {
    const other = rebuilt.leaves[path]
    if (other === undefined) onlyPublished.push(path)
    else if (other !== leaf) changed.push(path)
  }
  for (const path of Object.keys(rebuilt.leaves)) if (published.leaves[path] === undefined) onlyRebuilt.push(path)
  const known = published.cid !== undefined && rebuilt.cid !== undefined
  const cidMatch = known ? published.cid === rebuilt.cid : undefined
  return {
    match: published.bundleHash === rebuilt.bundleHash && cidMatch !== false,
    bundleHash: { published: published.bundleHash, rebuilt: rebuilt.bundleHash },
    files: { changed: changed.sort(), onlyPublished: onlyPublished.sort(), onlyRebuilt: onlyRebuilt.sort() },
    cid: { ...(published.cid === undefined ? {} : { published: published.cid }), ...(rebuilt.cid === undefined ? {} : { rebuilt: rebuilt.cid }), ...(cidMatch === undefined ? {} : { match: cidMatch }) }
  }
}

function listed (title: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return []
  const shown = paths.slice(0, 20).map((path) => `    ${path}`)
  if (paths.length > shown.length) shown.push(`    ...and ${String(paths.length - shown.length)} more`)
  return [`  ${title} (${String(paths.length)}):`, ...shown]
}

export interface ReportContext {
  readonly app: string
  readonly base: string
  readonly commit: string
  /** Where the commit came from: the published manifest, or the person's `--commit`. */
  readonly commitFrom: 'manifest' | 'flag'
}

/** The result as a person reads it: the verdict first, then both values of everything compared. */
export function formatReport (context: ReportContext, rebuilt: Rebuilt, result: Comparison): string {
  const lines = [
    `[${context.app}] ${result.match ? 'MATCH' : 'MISMATCH'}`,
    `  published tree     ${context.base}`,
    `  rebuilt at commit  ${context.commit} (${context.commitFrom === 'manifest' ? "named by the published manifest's source.portsCommit" : 'given with --commit'})`,
    `  bundleHash published  ${result.bundleHash.published}`,
    `  bundleHash rebuilt    ${result.bundleHash.rebuilt}  ${result.bundleHash.published === result.bundleHash.rebuilt ? 'same' : 'different'}`
  ]
  if (result.cid.rebuilt !== undefined) {
    lines.push(`  CID rebuilt           ${result.cid.rebuilt}  (ipfs add ${IPFS_ADD_FLAGS.join(' ')})`)
    lines.push(`  CID published         ${result.cid.published ?? 'not known -- pass --cid <cid> to compare it'}${result.cid.match === undefined ? '' : (result.cid.match ? '  same' : '  different')}`)
  } else {
    lines.push(`  CID rebuilt           not computed: ${rebuilt.cidNote ?? 'no ipfs command'}`)
  }
  if (result.bundleHash.published !== result.bundleHash.rebuilt) {
    const { changed, onlyPublished, onlyRebuilt } = result.files
    lines.push(...listed('files whose content differs', changed), ...listed('files only in the published tree', onlyPublished), ...listed('files only in the rebuilt tree', onlyRebuilt))
    if (changed.length + onlyPublished.length + onlyRebuilt.length === 0) lines.push('  every file matches its published hash, so the difference is in the ddoc file itself')
  }
  return `${lines.join('\n')}\n`
}

/** The base URL a published tree is read from: `--from`, else the app's own name served through eth.limo. */
export function publishedBase (domain: string | undefined, from: string | undefined): string {
  if (from !== undefined) {
    const url = new URL(from)
    const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !loopback) throw new Error(`--from ${from}: only https:// addresses are read (http:// only on this machine)`)
    return url.href.endsWith('/') ? url.href : `${url.href}/`
  }
  if (domain === undefined || !domain.endsWith('.eth')) {
    throw new Error('the app\'s manifest has no .eth "domain" to read the published tree from -- pass --from <https address of the published tree>')
  }
  return `https://${domain}.limo/`
}

export interface FetchedText {
  readonly text: string
  readonly headers: Readonly<Record<string, string>>
}

export interface VerifyDeps {
  readonly fetchText: (url: string) => Promise<FetchedText>
  readonly rebuild: (commit: string) => Promise<Rebuilt>
}

export interface VerifyRequest {
  readonly app: string
  readonly domain: string | undefined
  readonly from?: string
  readonly commit?: string
  readonly cid?: string
  /** A `website` recipe's tree, whose record is `orivon-website.json` rather than a manifest. */
  readonly website?: boolean
}

/** The first root a gateway names for the tree, when it names one. */
function rootFrom (headers: Readonly<Record<string, string>>): string | undefined {
  return headers['x-ipfs-roots']?.split(',')[0]?.trim()
}

export async function verifyApp (request: VerifyRequest, deps: VerifyDeps): Promise<{ report: string, comparison: Comparison }> {
  const base = publishedBase(request.domain, request.from)
  const manifest = await deps.fetchText(`${base}${(request.website === true ? WEBSITE_MANIFEST : MANIFEST).replaceAll('\\', '/')}`)
  const ddoc = await deps.fetchText(`${base}${DDOC.replaceAll('\\', '/')}`)
  const published = parsePublished(manifest.text, ddoc.text, request.cid ?? rootFrom(manifest.headers))
  const commit = request.commit ?? published.portsCommit
  if (commit === undefined) {
    throw new Error(`[${request.app}] the published manifest does not say which orivon-ports commit built it (no source.portsCommit) -- pass the commit with --commit <sha>`)
  }
  if (!FULL_SHA.test(commit)) throw new Error(`--commit ${commit} is not a full 40-character commit sha`)
  const rebuilt = await deps.rebuild(commit)
  const comparison = compare(published, rebuilt)
  return { comparison, report: formatReport({ app: request.app, base, commit, commitFrom: request.commit === undefined ? 'manifest' : 'flag' }, rebuilt, comparison) }
}

/** A text file over https, with the headers a gateway names the tree's root in. */
export async function fetchText (url: string): Promise<FetchedText> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`)
  return { text: await response.text(), headers: Object.fromEntries(response.headers.entries()) }
}

function exec (command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' })
    child.once('error', reject)
    child.once('exit', (code) => { if (code === 0) resolve(); else reject(new Error(`${command} ${args.join(' ')} failed (exit ${String(code)}) in ${cwd}`)) })
  })
}

export interface RebuildOptions {
  readonly app: string
  /** Where the clone is made from: this checkout, which holds most commits. */
  readonly checkout: string
  /** Asked for a commit the checkout does not hold. */
  readonly remote: string
  readonly keep: boolean
}

/**
 * The tree this repository builds for `app` at `commit`, from a clone with an
 * empty `out/`: that commit's own `src/cli.ts` runs the build, so it is the
 * pipeline of that day that is judged, not today's.
 */
export async function rebuildAtCommit (options: RebuildOptions, commit: string): Promise<Rebuilt> {
  const parent = await mkdtemp(join(tmpdir(), 'orivon-verify-'))
  const clone = join(parent, 'ports')
  try {
    await exec('git', ['clone', '-q', '--no-checkout', options.checkout, clone], parent)
    try {
      await exec('git', ['checkout', '-q', '--detach', commit], clone)
    } catch {
      process.stdout.write(`[${options.app}] ${commit.slice(0, 8)} is not in the local checkout -- fetching it from ${options.remote}\n`)
      await exec('git', ['fetch', '-q', options.remote, commit], clone)
      await exec('git', ['checkout', '-q', '--detach', commit], clone)
    }
    // The extra-apps variable would point the build at recipes outside the commit.
    const { ORIVON_PORTS_EXTRA_APPS: _outside, ...env } = process.env
    await exec('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], clone, env)
    await exec(process.execPath, ['src/cli.ts', 'build', options.app, '--rebuild'], clone, env)
    const tree = join(clone, 'out', options.app, 'static')
    const ddoc = JSON.parse(await readFile(join(tree, DDOC), 'utf8')) as { bundleHash: string, leaves: Record<string, string> }
    const rebuilt: Rebuilt = { bundleHash: ddoc.bundleHash, leaves: ddoc.leaves }
    try {
      return { ...rebuilt, cid: await cidOfTree(tree) }
    } catch (error) {
      if (!(error instanceof IpfsMissingError)) throw error
      return { ...rebuilt, cidNote: error.message }
    }
  } finally {
    if (options.keep) process.stdout.write(`[${options.app}] kept the clone at ${clone}\n`)
    else await rm(parent, { recursive: true, force: true })
  }
}

/** `Kubo 0.43.1`, or a note that none is installed: printed with a computed CID so it can be reproduced. */
export async function kuboNote (): Promise<string> {
  const version = await kuboVersion()
  return version === undefined ? 'Kubo is not installed' : `Kubo ${version}`
}

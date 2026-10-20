import { githubRepoOf, refPath } from './github-api.ts'
import type { GithubApi } from './github-api.ts'
import { isSite } from './recipe.ts'
import type { Recipe } from './recipe.ts'

// Finding out that an app's upstream has released something newer than its
// pin, and keeping exactly one open issue per app that says so. The choosing,
// comparing and wording are pure; the GitHub reads and writes go through
// `GithubApi`, which the tests replace. Opening a pull request that moves the
// pin is `src/pin-pr.ts`, switched on separately.

export interface Pin {
  readonly id: string
  readonly name: string
  readonly repo: string
  readonly ref: string
  readonly tagPattern?: string
  readonly prerelease?: boolean
}

interface Release {
  readonly tag_name: string
  readonly draft: boolean
  readonly prerelease: boolean
  readonly published_at: string | null
  readonly created_at?: string
  readonly html_url: string
  readonly body: string | null
}

export type Finding =
  | { readonly kind: 'update', readonly app: string, readonly name: string, readonly pinned: string, readonly tag: string, readonly commit: string, readonly url: string, readonly published: string, readonly notes: string }
  | { readonly kind: 'current', readonly app: string, readonly name: string, readonly tag: string, readonly why: 'at-release' | 'past-release' }
  | { readonly kind: 'none', readonly app: string, readonly name: string, readonly why: string }
  | { readonly kind: 'error', readonly app: string, readonly name: string, readonly why: string }

const NOTES_LINES = 12
const NOTES_CHARS = 1200

/** The apps that are somebody else's, on GitHub: the ones with a pin to watch. */
export function pinsOf (recipes: readonly Recipe[]): Pin[] {
  const pins: Pin[] = []
  for (const recipe of recipes) {
    if (isSite(recipe)) continue
    const repo = githubRepoOf(recipe.upstream.repo)
    if (repo === undefined) continue
    pins.push({
      id: recipe.id,
      name: recipe.name,
      repo,
      ref: recipe.upstream.ref,
      ...(recipe.upstream.tagPattern === undefined ? {} : { tagPattern: recipe.upstream.tagPattern }),
      ...(recipe.upstream.prerelease === true ? { prerelease: true } : {})
    })
  }
  return pins
}

const when = (release: Release): number => Date.parse(release.published_at ?? release.created_at ?? '') || 0

/**
 * The newest release that counts: not a draft, not a pre-release (unless the
 * recipe says upstream publishes its releases that way), and with a tag the
 * recipe's pattern accepts. Newest by publication date, not by list order.
 */
export function chooseRelease (releases: readonly Release[], rules: Pick<Pin, 'tagPattern' | 'prerelease'>): Release | undefined {
  const pattern = rules.tagPattern === undefined ? undefined : new RegExp(rules.tagPattern)
  const counted = releases.filter((release) =>
    !release.draft && (rules.prerelease === true || !release.prerelease) && (pattern === undefined || pattern.test(release.tag_name)))
  return counted.reduce<Release | undefined>((newest, release) => newest === undefined || when(release) > when(newest) ? release : newest, undefined)
}

/** The first lines of the release notes, bounded: they are a hint of what changed, not a copy. */
export function notesExcerpt (body: string | null): string {
  const lines = (body ?? '').replace(/\r/g, '').split('\n').map((line) => line.trimEnd())
  const kept: string[] = []
  for (const line of lines) {
    if (line === '' && kept.length === 0) continue
    kept.push(line)
    if (kept.length >= NOTES_LINES) break
  }
  const text = kept.join('\n').trim()
  if (text.length <= NOTES_CHARS) return text
  // Cut at the end of a line when there is one, so a list item or a link is not left half written.
  const cut = text.slice(0, NOTES_CHARS)
  const lastLine = cut.lastIndexOf('\n')
  return `${(lastLine > 0 ? cut.slice(0, lastLine) : cut).trimEnd()}\n...`
}

interface Commit { readonly sha: string, readonly commit?: { readonly committer?: { readonly date?: string } } }
interface Comparison { readonly status: string, readonly base_commit?: Commit }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * Whether the release commit is a newer state of the project than the pin. A
 * release ahead of the pin is; one behind it, or at it, is not (the pin
 * already holds it). Diverged histories, which a release cut from a branch
 * gives, are decided by which commit is newer in time.
 */
export function newerThanPin (comparison: Comparison, releaseDate: string | undefined): boolean {
  if (comparison.status === 'ahead') return true
  if (comparison.status !== 'diverged') return false
  const pinDate = Date.parse(comparison.base_commit?.commit?.committer?.date ?? '')
  const releaseTime = Date.parse(releaseDate ?? '')
  return Number.isFinite(pinDate) && Number.isFinite(releaseTime) && releaseTime > pinDate
}

export async function scanPin (api: GithubApi, pin: Pin): Promise<Finding> {
  const base = { app: pin.id, name: pin.name }
  try {
    const listed = await api.get(`/repos/${pin.repo}/releases?per_page=100`)
    const release = Array.isArray(listed) ? chooseRelease(listed as Release[], pin) : undefined
    if (release === undefined) return { kind: 'none', ...base, why: 'upstream has no release that counts (a stable one, whose tag matches the recipe)' }
    const commit = await api.get(`/repos/${pin.repo}/commits/${refPath(release.tag_name)}`) as Commit | undefined
    if (!isObject(commit) || typeof commit.sha !== 'string') return { kind: 'error', ...base, why: `the tag ${release.tag_name} did not resolve to a commit` }
    if (commit.sha === pin.ref) return { kind: 'current', ...base, tag: release.tag_name, why: 'at-release' }
    const compared = await api.get(`/repos/${pin.repo}/compare/${pin.ref}...${commit.sha}?per_page=1`) as Comparison | undefined
    // A pin GitHub cannot compare is not provably ahead of anything: it is reported as behind the release.
    if (compared !== undefined && !newerThanPin(compared, commit.commit?.committer?.date)) return { kind: 'current', ...base, tag: release.tag_name, why: 'past-release' }
    return {
      kind: 'update',
      ...base,
      pinned: pin.ref,
      tag: release.tag_name,
      commit: commit.sha,
      url: release.html_url,
      published: (release.published_at ?? release.created_at ?? '').slice(0, 10),
      notes: notesExcerpt(release.body)
    }
  } catch (error) {
    return { kind: 'error', ...base, why: error instanceof Error ? error.message : String(error) }
  }
}

export async function scanAll (api: GithubApi, pins: readonly Pin[]): Promise<Finding[]> {
  const findings: Finding[] = []
  for (const pin of pins) findings.push(await scanPin(api, pin))
  return findings
}

// ---- the issues ---------------------------------------------------------

export const marker = (app: string): string => `<!-- orivon-upstream-release:${app} -->`
export const issueTitle = (name: string, tag: string): string => `Upstream release available: ${name} ${tag}`

/** `text` in a code span or block that its own backticks cannot close. */
function fenced (text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}text\n${text}\n${fence}`
}

function span (text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length))
  const ticks = '`'.repeat(longest + 1)
  return `${ticks}${text}${ticks}`
}

export function issueBody (finding: Extract<Finding, { kind: 'update' }>): string {
  return [
    marker(finding.app),
    `Upstream has published a release newer than the commit ${finding.name} is pinned to.`,
    '',
    '| | |',
    '|---|---|',
    `| App | ${span(finding.app)} |`,
    `| Pinned commit | ${span(finding.pinned)} (${span(`apps/${finding.app}/recipe.json`)}) |`,
    `| Release | [${finding.tag.replace(/[[\]\\]/g, '\\$&')}](${finding.url}) |`,
    `| Release commit | ${span(finding.commit)} |`,
    `| Published | ${finding.published} |`,
    '',
    finding.notes === '' ? 'The release has no notes.' : `The release notes begin:\n\n${fenced(finding.notes)}`,
    '',
    `To build it before editing the recipe: ${span(`node src/cli.ts build ${finding.app} --rebuild --ref ${finding.commit}`)}.`,
    'Moving the pin is the "A new upstream release" job in `.claude/skills/orivon-porting/maintain.md`.',
    '',
    'This issue is kept up to date by the upstream release watcher, and closes itself once the pin catches up.'
  ].join('\n')
}

export interface OpenIssue {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: 'open' | 'closed'
  readonly author: string
}

export type Action =
  | { readonly type: 'create', readonly app: string, readonly title: string, readonly body: string }
  | { readonly type: 'update', readonly app: string, readonly number: number, readonly title: string, readonly body: string }
  | { readonly type: 'close', readonly app: string, readonly number: number, readonly comment: string }

export const WATCHER_LOGIN = 'github-actions[bot]'

/** The issues this watcher wrote for an app: its marker, written by the watcher's own account. */
function ownedBy (issues: readonly OpenIssue[], app: string): OpenIssue[] {
  return issues.filter((issue) => issue.author === WATCHER_LOGIN && issue.body.includes(marker(app))).sort((a, b) => a.number - b.number)
}

/**
 * What to do to the issues, one open issue per app at most. A pin that is
 * behind its release gets one issue, edited when a newer release replaces the
 * tag; a pin that caught up closes it; a closed issue for the same tag stays
 * closed, because a person closed it on purpose. A failed or empty scan never
 * closes anything: not knowing is not a catch-up.
 */
export function planIssues (findings: readonly Finding[], issues: readonly OpenIssue[]): Action[] {
  const actions: Action[] = []
  for (const finding of findings) {
    const mine = ownedBy(issues, finding.app)
    const open = mine.filter((issue) => issue.state === 'open')
    if (finding.kind === 'update') {
      const title = issueTitle(finding.name, finding.tag)
      const body = issueBody(finding)
      const [keep, ...extra] = open
      if (keep === undefined) {
        if (!mine.some((issue) => issue.title === title)) actions.push({ type: 'create', app: finding.app, title, body })
      } else if (keep.title !== title || keep.body !== body) {
        actions.push({ type: 'update', app: finding.app, number: keep.number, title, body })
      }
      for (const duplicate of extra) actions.push({ type: 'close', app: finding.app, number: duplicate.number, comment: `Closing in favour of #${String(keep?.number)}: one issue per app.` })
    } else if (finding.kind === 'current') {
      const why = finding.why === 'at-release' ? `the pin is at ${finding.tag}` : `the pin is already past ${finding.tag}`
      for (const issue of open) actions.push({ type: 'close', app: finding.app, number: issue.number, comment: `Closing: ${why}.` })
    }
  }
  return actions
}

export function describeAction (action: Action): string {
  if (action.type === 'create') return `open an issue: ${action.title}`
  if (action.type === 'update') return `update #${String(action.number)}: ${action.title}`
  return `close #${String(action.number)} (${action.app})`
}

/** The first of `wanted` that is already a label of the repository; nothing is ever created. */
export function chooseLabel (existing: readonly string[], wanted: readonly string[]): string | undefined {
  return wanted.find((label) => existing.includes(label))
}

export const LABEL_CANDIDATES = ['upstream-release', 'dependencies'] as const

export async function listIssues (api: GithubApi, repo: string): Promise<OpenIssue[]> {
  const found: OpenIssue[] = []
  for (let page = 1; page <= 10; page++) {
    const batch = await api.get(`/repos/${repo}/issues?state=all&per_page=100&page=${String(page)}`)
    if (!Array.isArray(batch)) break
    for (const raw of batch as unknown[]) {
      if (!isObject(raw) || raw['pull_request'] !== undefined) continue
      const user = raw['user']
      found.push({
        number: Number(raw['number']),
        title: String(raw['title'] ?? ''),
        body: String(raw['body'] ?? ''),
        state: raw['state'] === 'closed' ? 'closed' : 'open',
        author: isObject(user) ? String(user['login'] ?? '') : ''
      })
    }
    if (batch.length < 100) break
  }
  return found
}

export async function listLabels (api: GithubApi, repo: string): Promise<string[]> {
  const labels = await api.get(`/repos/${repo}/labels?per_page=100`)
  return Array.isArray(labels) ? (labels as unknown[]).flatMap((label) => isObject(label) && typeof label['name'] === 'string' ? [label['name']] : []) : []
}

export async function applyActions (api: GithubApi, repo: string, actions: readonly Action[], label: string | undefined): Promise<void> {
  for (const action of actions) {
    if (action.type === 'create') {
      await api.post(`/repos/${repo}/issues`, { title: action.title, body: action.body, ...(label === undefined ? {} : { labels: [label] }) })
    } else if (action.type === 'update') {
      await api.patch(`/repos/${repo}/issues/${String(action.number)}`, { title: action.title, body: action.body })
    } else {
      await api.post(`/repos/${repo}/issues/${String(action.number)}/comments`, { body: action.comment })
      await api.patch(`/repos/${repo}/issues/${String(action.number)}`, { state: 'closed', state_reason: 'completed' })
    }
  }
}

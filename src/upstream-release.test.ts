import { describe, expect, it } from 'vitest'
import type { GithubApi } from './github-api.ts'
import { githubRepoOf, refPath } from './github-api.ts'
import { parseRecipe } from './recipe.ts'
import {
  WATCHER_LOGIN, applyActions, chooseLabel, chooseRelease, issueBody, issueTitle, marker, newerThanPin, notesExcerpt, pinsOf, planIssues, scanAll, scanPin
} from './upstream-release.ts'
import type { Finding, OpenIssue, Pin } from './upstream-release.ts'

const PIN = 'a'.repeat(40)
const NEW = 'b'.repeat(40)

const release = (tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag_name: tag, draft: false, prerelease: false, published_at: '2026-10-01T00:00:00Z', html_url: `https://github.com/o/r/releases/tag/${tag}`, body: `Notes for ${tag}`, ...extra
})

describe('chooseRelease', () => {
  it('takes the newest by publication date, not by list order', () => {
    const chosen = chooseRelease([release('v1', { published_at: '2026-01-01T00:00:00Z' }), release('v3', { published_at: '2026-03-01T00:00:00Z' }), release('v2', { published_at: '2026-02-01T00:00:00Z' })] as never, {})
    expect(chosen?.tag_name).toBe('v3')
  })

  it('skips drafts and pre-releases', () => {
    const list = [release('v2-rc.1', { prerelease: true, published_at: '2026-03-01T00:00:00Z' }), release('v3', { draft: true, published_at: '2026-04-01T00:00:00Z' }), release('v1')]
    expect(chooseRelease(list as never, {})?.tag_name).toBe('v1')
  })

  it('accepts pre-releases when the recipe says upstream publishes its releases that way, but never drafts', () => {
    const list = [release('v0.25.3-beta', { prerelease: true }), release('v0.26.0-beta', { draft: true, prerelease: true, published_at: '2026-12-01T00:00:00Z' })]
    expect(chooseRelease(list as never, { prerelease: true })?.tag_name).toBe('v0.25.3-beta')
  })

  it('keeps only tags the recipe\'s pattern accepts', () => {
    const list = [release('live-mobile@4.24.0', { published_at: '2026-10-14T00:00:00Z' }), release('@ledgerhq/live-desktop@4.23.1', { published_at: '2026-10-09T00:00:00Z' })]
    expect(chooseRelease(list as never, { tagPattern: '^@ledgerhq/live-desktop@\\d+\\.\\d+\\.\\d+$' })?.tag_name).toBe('@ledgerhq/live-desktop@4.23.1')
  })

  it('finds nothing when nothing counts', () => {
    expect(chooseRelease([], {})).toBeUndefined()
    expect(chooseRelease([release('v1', { prerelease: true })] as never, {})).toBeUndefined()
  })
})

describe('notesExcerpt', () => {
  it('keeps the first lines and drops leading blanks', () => {
    expect(notesExcerpt('\n\r\n## Fixes\r\n- a\n- b')).toBe('## Fixes\n- a\n- b')
  })

  it('bounds the number of lines and the length', () => {
    expect(notesExcerpt(Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join('\n')).split('\n')).toHaveLength(12)
    const long = notesExcerpt('x'.repeat(5000))
    expect(long.length).toBeLessThan(1210)
    expect(long.endsWith('...')).toBe(true)
  })

  it('cuts a long excerpt at the end of a line, never inside one', () => {
    const lines = Array.from({ length: 11 }, (_, i) => `${String(i)} ${'y'.repeat(150)}`)
    const cut = notesExcerpt(lines.join('\n'))
    expect(cut.endsWith('\n...')).toBe(true)
    expect(cut.split('\n').slice(0, -1).every((line) => lines.includes(line))).toBe(true)
  })

  it('is empty for no notes', () => {
    expect(notesExcerpt(null)).toBe('')
  })
})

describe('newerThanPin', () => {
  it('is true for a release ahead of the pin and false for one behind it or at it', () => {
    expect(newerThanPin({ status: 'ahead' }, undefined)).toBe(true)
    expect(newerThanPin({ status: 'behind' }, '2030-01-01T00:00:00Z')).toBe(false)
    expect(newerThanPin({ status: 'identical' }, undefined)).toBe(false)
  })

  it('decides diverged histories by which commit is newer in time', () => {
    const pinned = { status: 'diverged', base_commit: { sha: PIN, commit: { committer: { date: '2026-09-01T00:00:00Z' } } } }
    expect(newerThanPin(pinned, '2026-10-01T00:00:00Z')).toBe(true)
    expect(newerThanPin(pinned, '2026-08-01T00:00:00Z')).toBe(false)
    expect(newerThanPin({ status: 'diverged' }, '2026-08-01T00:00:00Z')).toBe(false)
  })
})

function api (routes: Record<string, unknown>): GithubApi & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    get: async (path) => { calls.push(path); if (path in routes) { const value = routes[path]; if (value instanceof Error) throw value; return value } return undefined },
    post: async () => undefined,
    patch: async () => undefined
  }
}

const pin: Pin = { id: 'demo', name: 'Demo', repo: 'o/r', ref: PIN }

describe('scanPin', () => {
  const releases = '/repos/o/r/releases?per_page=100'

  it('reports an update when the newest stable release is ahead of the pin', async () => {
    const fake = api({
      [releases]: [release('v2'), release('v1', { published_at: '2026-01-01T00:00:00Z' })],
      '/repos/o/r/commits/v2': { sha: NEW, commit: { committer: { date: '2026-10-01T00:00:00Z' } } },
      [`/repos/o/r/compare/${PIN}...${NEW}?per_page=1`]: { status: 'ahead' }
    })
    expect(await scanPin(fake, pin)).toEqual({ kind: 'update', app: 'demo', name: 'Demo', pinned: PIN, tag: 'v2', commit: NEW, url: 'https://github.com/o/r/releases/tag/v2', published: '2026-10-01', notes: 'Notes for v2' })
  })

  it('reports current, without comparing, when the release commit is the pin', async () => {
    const fake = api({ [releases]: [release('v2')], '/repos/o/r/commits/v2': { sha: PIN } })
    expect(await scanPin(fake, pin)).toEqual({ kind: 'current', app: 'demo', name: 'Demo', tag: 'v2', why: 'at-release' })
    expect(fake.calls.some((call) => call.includes('/compare/'))).toBe(false)
  })

  it('reports current when the pin is already past the release', async () => {
    const fake = api({ [releases]: [release('v2')], '/repos/o/r/commits/v2': { sha: NEW }, [`/repos/o/r/compare/${PIN}...${NEW}?per_page=1`]: { status: 'behind' } })
    expect(await scanPin(fake, pin)).toMatchObject({ kind: 'current', why: 'past-release' })
  })

  it('resolves a tag with slashes and an @ through an encoded path', async () => {
    expect(refPath('@ledgerhq/live-desktop@4.24.0')).toBe('%40ledgerhq/live-desktop%404.24.0')
  })

  it('says so when upstream has no release that counts', async () => {
    expect(await scanPin(api({ [releases]: [release('v1', { prerelease: true })] }), pin)).toMatchObject({ kind: 'none' })
    expect(await scanPin(api({}), pin)).toMatchObject({ kind: 'none' })
  })

  it('reports an error, not a catch-up, when GitHub fails', async () => {
    const finding = await scanPin(api({ [releases]: new Error('GitHub GET answered 403: rate limit exceeded') }), pin)
    expect(finding).toMatchObject({ kind: 'error', why: expect.stringContaining('rate limit') })
  })

  it('scans every pin and never lets one failure hide another', async () => {
    const fake = api({ '/repos/o/r/releases?per_page=100': new Error('boom'), '/repos/o/s/releases?per_page=100': [release('v1')], '/repos/o/s/commits/v1': { sha: PIN } })
    const found = await scanAll(fake, [pin, { ...pin, id: 'other', repo: 'o/s' }])
    expect(found.map((finding) => finding.kind)).toEqual(['error', 'current'])
  })
})

describe('pinsOf', () => {
  const recipe = (extra: Record<string, unknown>): ReturnType<typeof parseRecipe> => parseRecipe({
    id: 'demo', name: 'Demo', port: 8890, manifest: 'orivon.json', build: { command: 'true', output: 'dist' },
    upstream: { repo: 'https://github.com/o/r.git', ref: PIN, licence: 'MIT', ...extra }
  }, 'recipe.json')

  it('lists a GitHub port with its release rules, and skips a site and a non-GitHub upstream', () => {
    const site = parseRecipe({ id: 'site', name: 'Site', port: 8891, site: 'site', manifest: 'orivon.json' }, 'recipe.json')
    const elsewhere = parseRecipe({ id: 'else', name: 'Else', port: 8892, manifest: 'orivon.json', build: { command: 'true', output: 'dist' }, upstream: { repo: 'https://gitlab.com/o/r.git', ref: PIN, licence: 'MIT' } }, 'recipe.json')
    expect(pinsOf([recipe({ tagPattern: '^v', prerelease: true }), site, elsewhere])).toEqual([{ id: 'demo', name: 'Demo', repo: 'o/r', ref: PIN, tagPattern: '^v', prerelease: true }])
  })

  it('reads owner/name from a repository URL', () => {
    expect(githubRepoOf('https://github.com/element-hq/element-web.git')).toBe('element-hq/element-web')
    expect(githubRepoOf('https://github.com/asgardex/asgardex-desktop')).toBe('asgardex/asgardex-desktop')
    expect(githubRepoOf('https://example.com/o/r.git')).toBeUndefined()
  })
})

describe('the issue text', () => {
  const update: Extract<Finding, { kind: 'update' }> = { kind: 'update', app: 'demo', name: 'Demo', pinned: PIN, tag: 'v2', commit: NEW, url: 'https://github.com/o/r/releases/tag/v2', published: '2026-10-01', notes: '## Fixes\n- a' }

  it('titles it with the app and the tag', () => {
    expect(issueTitle('Demo', 'v2')).toBe('Upstream release available: Demo v2')
  })

  it('carries the marker, both commits, the release link and the first lines of the notes', () => {
    const body = issueBody(update)
    expect(body.startsWith(marker('demo'))).toBe(true)
    expect(body).toContain(`\`${PIN}\``)
    expect(body).toContain(`\`${NEW}\``)
    expect(body).toContain('[v2](https://github.com/o/r/releases/tag/v2)')
    expect(body).toContain('```text\n## Fixes\n- a\n```')
    expect(body).toContain(`--ref ${NEW}`)
  })

  it('keeps notes with backticks or mentions inside a fence they cannot close', () => {
    const body = issueBody({ ...update, notes: 'thanks @someone ``` evil\n[x](y)' })
    expect(body).toContain('````text\nthanks @someone ``` evil\n[x](y)\n````')
  })

  it('says when the release has no notes', () => {
    expect(issueBody({ ...update, notes: '' })).toContain('The release has no notes.')
  })
})

describe('planIssues', () => {
  const update = (tag = 'v2'): Finding => ({ kind: 'update', app: 'demo', name: 'Demo', pinned: PIN, tag, commit: NEW, url: `https://github.com/o/r/releases/tag/${tag}`, published: '2026-10-01', notes: 'n' })
  const issueFor = (finding: Finding, extra: Partial<OpenIssue> = {}): OpenIssue => {
    if (finding.kind !== 'update') throw new Error('an update')
    return { number: 7, title: issueTitle(finding.name, finding.tag), body: issueBody(finding), state: 'open', author: WATCHER_LOGIN, ...extra }
  }

  it('opens one issue for an update with none yet', () => {
    const [action, ...more] = planIssues([update()], [])
    expect(more).toEqual([])
    expect(action).toMatchObject({ type: 'create', title: 'Upstream release available: Demo v2' })
  })

  it('does nothing when the open issue already says it', () => {
    expect(planIssues([update()], [issueFor(update())])).toEqual([])
  })

  it('edits the one issue, not a second, when a newer release replaces the tag', () => {
    expect(planIssues([update('v3')], [issueFor(update('v2'))])).toEqual([
      expect.objectContaining({ type: 'update', number: 7, title: 'Upstream release available: Demo v3' })
    ])
  })

  it('does not reopen an issue a person closed for the same release', () => {
    expect(planIssues([update()], [issueFor(update(), { state: 'closed' })])).toEqual([])
  })

  it('opens a new one for a later release after the earlier one was closed', () => {
    expect(planIssues([update('v3')], [issueFor(update('v2'), { state: 'closed' })])).toEqual([expect.objectContaining({ type: 'create' })])
  })

  it('closes duplicates of the same app, keeping the lowest number', () => {
    const actions = planIssues([update()], [issueFor(update(), { number: 9 }), issueFor(update(), { number: 4 })])
    expect(actions).toEqual([expect.objectContaining({ type: 'close', number: 9 })])
  })

  it('closes the issue once the pin catches up, or passes the release', () => {
    const caught: Finding = { kind: 'current', app: 'demo', name: 'Demo', tag: 'v2', why: 'at-release' }
    expect(planIssues([caught], [issueFor(update())])).toEqual([expect.objectContaining({ type: 'close', number: 7, comment: expect.stringContaining('at v2') })])
    expect(planIssues([{ ...caught, why: 'past-release' }], [issueFor(update())])[0]).toMatchObject({ comment: expect.stringContaining('past v2') })
  })

  it('closes nothing when the scan failed or found no release: not knowing is not a catch-up', () => {
    const open = [issueFor(update())]
    expect(planIssues([{ kind: 'error', app: 'demo', name: 'Demo', why: 'x' }], open)).toEqual([])
    expect(planIssues([{ kind: 'none', app: 'demo', name: 'Demo', why: 'x' }], open)).toEqual([])
  })

  it('ignores an issue that carries the marker but was not written by the watcher', () => {
    expect(planIssues([update()], [issueFor(update(), { author: 'someone' })])).toEqual([expect.objectContaining({ type: 'create' })])
  })

  it('keeps apps apart', () => {
    const other: Finding = { ...update(), app: 'other', name: 'Other' }
    expect(planIssues([update(), other], [issueFor(update())])).toEqual([expect.objectContaining({ type: 'create', app: 'other' })])
  })
})

describe('applyActions and labels', () => {
  function recorder (): GithubApi & { writes: Array<[string, string, unknown]> } {
    const writes: Array<[string, string, unknown]> = []
    return { writes, get: async () => undefined, post: async (path, body) => { writes.push(['POST', path, body]) }, patch: async (path, body) => { writes.push(['PATCH', path, body]) } }
  }

  it('creates, edits and closes through the issues API', async () => {
    const fake = recorder()
    await applyActions(fake, 'o/ports', [
      { type: 'create', app: 'a', title: 'T', body: 'B' },
      { type: 'update', app: 'a', number: 3, title: 'T2', body: 'B2' },
      { type: 'close', app: 'a', number: 5, comment: 'done' }
    ], undefined)
    expect(fake.writes).toEqual([
      ['POST', '/repos/o/ports/issues', { title: 'T', body: 'B' }],
      ['PATCH', '/repos/o/ports/issues/3', { title: 'T2', body: 'B2' }],
      ['POST', '/repos/o/ports/issues/5/comments', { body: 'done' }],
      ['PATCH', '/repos/o/ports/issues/5', { state: 'closed', state_reason: 'completed' }]
    ])
  })

  it('labels a new issue only with a label the repository already has', async () => {
    const fake = recorder()
    await applyActions(fake, 'o/ports', [{ type: 'create', app: 'a', title: 'T', body: 'B' }], chooseLabel(['bug', 'dependencies'], ['upstream-release', 'dependencies']))
    expect(fake.writes[0]?.[2]).toMatchObject({ labels: ['dependencies'] })
    expect(chooseLabel(['bug', 'enhancement'], ['upstream-release', 'dependencies'])).toBeUndefined()
  })
})

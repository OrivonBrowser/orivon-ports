import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST, declareBundle } from './declare.ts'
import { EXTRA_APPS_ENV, REPO_ROOT } from './paths.ts'
import { releaseTree } from './release.ts'

// `hash --check` through the command line, on an app whose manifest id is not its recipe id, as
// every real app's is: the lookup from a built tree to the app's release record is wired here.
const MANIFEST_ID = 'eth.demo.app'
const RECIPE = { id: 'demo', name: 'Demo', port: 8999, eth: 'demo.eth', hint: { tier: 1, name: 'Demo' }, site: 'site', manifest: 'orivon.json' }
const manifest = (version: string, id: string = MANIFEST_ID): string => JSON.stringify({ orivonApiVersion: 0, id, name: 'Demo', version, entry: 'index.html', capabilities: {} }, null, 2)

let root: string
let appDir: string
let tree: string

/** What prepare leaves: the app's manifest at `version`, a page, and the declaration. */
async function build (page: string, version = '0.24.0.2', id: string = MANIFEST_ID): Promise<void> {
  await rm(tree, { recursive: true, force: true })
  await mkdir(join(tree, '.well-known'), { recursive: true })
  await writeFile(join(tree, MANIFEST), manifest(version, id))
  await writeFile(join(tree, 'index.html'), page)
  await declareBundle(tree, { check: false })
}

const check = (...more: string[]): Promise<{ code: number, out: string, err: string }> =>
  new Promise((resolve) => {
    execFile(process.execPath, ['src/cli.ts', 'hash', tree, '--check', ...more], { cwd: REPO_ROOT, env: { ...process.env, [EXTRA_APPS_ENV]: appDir } }, (error, out, err) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, out, err })
    })
  })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orivon-hash-cli-'))
  appDir = join(root, 'demo')
  tree = join(root, 'static')
  await mkdir(appDir, { recursive: true })
  await writeFile(join(appDir, 'recipe.json'), JSON.stringify(RECIPE))
  await writeFile(join(appDir, 'orivon.json'), manifest('0.24.0.2'))
  await build('<title>one</title>')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('orivon-port hash --check against the release record', () => {
  it('finds the app by the tree\'s manifest id, passes the released tree, and says it compared', async () => {
    await releaseTree({ id: 'demo', appDir, manifest: 'orivon.json', tree })
    const result = await check()
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/release record: demo 0\.24\.0\.3 goes with apps\/demo\/published\.json/)
    const recorded = JSON.parse(await readFile(join(appDir, 'published.json'), 'utf8')) as { contentHash: string }
    expect(result.out).toContain(`content hash ${recorded.contentHash}`)
  })

  it('refuses a changed tree that kept the published version, and names the app to release', async () => {
    await releaseTree({ id: 'demo', appDir, manifest: 'orivon.json', tree })
    await build('<title>two</title>', '0.24.0.3')
    const result = await check()
    expect(result.code).not.toBe(0)
    expect(result.err).toMatch(/orivon-port release demo\b/)
  })

  it('says so when no app here has the tree\'s manifest id, rather than passing quietly', async () => {
    await build('<title>one</title>', '0.24.0.2', 'eth.nobody.app')
    const result = await check()
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/no app here has the manifest id "eth\.nobody\.app".*nothing was compared/)
  })

  it('says so when the app has no record yet', async () => {
    const result = await check()
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/demo has no published\.json.*nothing was compared/)
  })

  it('leaves the comparison out when asked to', async () => {
    await releaseTree({ id: 'demo', appDir, manifest: 'orivon.json', tree })
    await build('<title>two</title>', '0.24.0.3')
    const result = await check('--unreleased')
    expect(result.code).toBe(0)
    expect(result.out).not.toMatch(/release record/)
  })
})

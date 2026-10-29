import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MANIFEST, declareBundle } from './declare.ts'
import { assertReleased, publishProblem, readRecord, recordProblem, releaseTree, versionProblem } from './release.ts'

const REF_A = 'a'.repeat(40)
const REF_B = 'b'.repeat(40)
const HAND_WRITTEN = '{\n  "orivonApiVersion": 0,\n  "id": "eth.demo.app",\n  "name": "Demo",\n  "version": "0.24.0.2",\n  "entry": "index.html",\n  "capabilities": {}\n}\n'

describe('releasing a built tree', () => {
  let root: string
  let appDir: string
  let tree: string

  const put = async (path: string, content: string): Promise<void> => {
    await mkdir(dirname(join(tree, path)), { recursive: true })
    await writeFile(join(tree, path), content)
  }
  /** What prepare leaves behind: the app's manifest with its generated fields, and the declaration. */
  const build = async (options: { page?: string, version?: string, source?: string } = {}): Promise<void> => {
    await rm(tree, { recursive: true, force: true })
    const hand = JSON.parse(HAND_WRITTEN) as Record<string, unknown>
    const version = options.version ?? hand['version']
    await put(MANIFEST, JSON.stringify({ ...hand, version, ...options.source === undefined ? {} : { source: { portsCommit: options.source } } }, null, 2))
    await put('index.html', options.page ?? '<title>demo</title>')
    await put('app.js', 'console.log(1)')
    await declareBundle(tree, { check: false })
  }
  const target = (upstreamRef?: string): Parameters<typeof releaseTree>[0] => ({ id: 'demo', appDir, manifest: 'orivon.json', tree, ...upstreamRef === undefined ? {} : { upstreamRef } })
  const manifestFile = (): Promise<string> => readFile(join(appDir, 'orivon.json'), 'utf8')
  const builtManifest = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(tree, MANIFEST), 'utf8')) as Record<string, unknown>
  const record = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(appDir, 'published.json'), 'utf8')) as Record<string, unknown>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orivon-release-'))
    appDir = join(root, 'apps', 'demo')
    tree = join(root, 'out', 'demo', 'static')
    await mkdir(appDir, { recursive: true })
    await writeFile(join(appDir, 'orivon.json'), HAND_WRITTEN)
    await build()
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('raises the version once when there is no record yet, and records it', async () => {
    const result = await releaseTree(target(REF_A))
    expect(result).toMatchObject({ changed: true, version: '0.24.0.3' })
    expect(result.previous).toBeUndefined()
    expect(await record()).toMatchObject({ version: '0.24.0.3', upstreamRef: REF_A, contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) })
  })

  it('writes the new version into the manifest keeping its formatting, and into the built tree, which stays declared', async () => {
    await releaseTree(target())
    expect(await manifestFile()).toBe(HAND_WRITTEN.replace('0.24.0.2', '0.24.0.3'))
    expect((await builtManifest())['version']).toBe('0.24.0.3')
    await expect(declareBundle(tree, { check: true })).resolves.toBeDefined()
  })

  it('changes nothing when the same build is released again', async () => {
    const first = await releaseTree(target())
    const before = { orivon: await manifestFile(), recorded: await record(), built: await readFile(join(tree, MANIFEST), 'utf8') }
    const again = await releaseTree(target())
    expect(again).toMatchObject({ changed: false, version: '0.24.0.3', bundleHash: first.bundleHash })
    expect({ orivon: await manifestFile(), recorded: await record(), built: await readFile(join(tree, MANIFEST), 'utf8') }).toEqual(before)
  })

  it('treats a rebuild of the same files, prepared again with the raised version and another commit, as the same build', async () => {
    await releaseTree(target())
    await build({ version: '0.24.0.3', source: 'c'.repeat(40) })
    expect(await releaseTree(target())).toMatchObject({ changed: false, version: '0.24.0.3' })
    await build({ version: '0.24.0.3', source: 'd'.repeat(40) })
    expect(await releaseTree(target())).toMatchObject({ changed: false })
  })

  it('raises the version again when the files differ from the recorded ones', async () => {
    await releaseTree(target())
    await build({ version: '0.24.0.3', page: '<title>changed</title>' })
    expect(await releaseTree(target())).toMatchObject({ changed: true, version: '0.24.0.4', previous: '0.24.0.3' })
    expect((await builtManifest())['version']).toBe('0.24.0.4')
    expect(await manifestFile()).toContain('"version": "0.24.0.4"')
  })

  it('drops source from the rebuilt manifest: the checkout is no longer at the commit it names', async () => {
    await build({ source: 'c'.repeat(40) })
    expect((await builtManifest())['source']).toBeDefined()
    await releaseTree(target())
    expect((await builtManifest())['source']).toBeUndefined()
  })

  it('hashes the content without the version, whatever version the manifest says', async () => {
    const hashOf = async (version: string): Promise<string> => { await build({ version }); return (await declareBundle(tree, { check: true })).contentHash }
    expect(await hashOf('1.0.0')).toBe(await hashOf('9.9.9'))
    const base = await hashOf('1.0.0')
    await build({ version: '1.0.0', page: 'other' })
    expect((await declareBundle(tree, { check: true })).contentHash).not.toBe(base)
  })

  it('raises a seeded record (a version and no hash) once', async () => {
    await writeFile(join(appDir, 'published.json'), '{\n  "version": "0.24.0.2"\n}\n')
    expect(await releaseTree(target())).toMatchObject({ changed: true, version: '0.24.0.3', previous: '0.24.0.2' })
    expect(await releaseTree(target())).toMatchObject({ changed: false })
  })

  it('appends build 1 to the upstream version a person set after the pin moved', async () => {
    await writeFile(join(appDir, 'published.json'), JSON.stringify({ version: '0.24.0.2', upstreamRef: REF_A }))
    await writeFile(join(appDir, 'orivon.json'), HAND_WRITTEN.replace('0.24.0.2', '0.25.0'))
    await build({ version: '0.25.0' })
    expect(await releaseTree(target(REF_B))).toMatchObject({ changed: true, version: '0.25.0.1' })
    expect(await record()).toMatchObject({ upstreamRef: REF_B })
  })

  it('refuses a moved pin whose version was left as published, and touches nothing', async () => {
    await writeFile(join(appDir, 'published.json'), JSON.stringify({ version: '0.24.0.2', upstreamRef: REF_A }))
    await expect(releaseTree(target(REF_B))).rejects.toThrow(/pin moved.*set "version"/)
    expect(await manifestFile()).toBe(HAND_WRITTEN)
    expect((await record())['version']).toBe('0.24.0.2')
  })

  it('refuses a manifest below the recorded version', async () => {
    await writeFile(join(appDir, 'published.json'), JSON.stringify({ version: '0.24.0.9' }))
    await expect(releaseTree(target())).rejects.toThrow(/only go up/)
  })

  it('refuses a non-numeric version and writes nothing', async () => {
    await writeFile(join(appDir, 'orivon.json'), HAND_WRITTEN.replace('0.24.0.2', '0.24.0-beta'))
    await build({ version: '0.24.0-beta' })
    await expect(releaseTree(target())).rejects.toThrow(/numbers separated by dots/)
    await expect(readRecord(appDir)).resolves.toBeUndefined()
  })

  it('refuses a manifest moved by hand off the version these bytes were published as', async () => {
    await releaseTree(target())
    await writeFile(join(appDir, 'orivon.json'), HAND_WRITTEN.replace('0.24.0.2', '0.24.0.7'))
    await expect(releaseTree(target())).rejects.toThrow(/published as 0\.24\.0\.3/)
  })

  it('refuses a tree built before the manifest was last edited', async () => {
    await releaseTree(target())
    await build({ version: '0.24.0.1' })
    await writeFile(join(appDir, 'published.json'), JSON.stringify({ version: '0.24.0.3', contentHash: (await declareBundle(tree, { check: true })).contentHash }))
    await expect(releaseTree(target())).rejects.toThrow(/build it again/)
  })

  it('refuses a tree that no longer matches its declaration', async () => {
    await writeFile(join(tree, 'app.js'), 'tampered')
    await expect(releaseTree(target())).rejects.toThrow(/no longer match/)
  })

  describe('hash --check refusal', () => {
    // The tree names itself by its manifest's id; the app is known by its recipe's, here `demo`.
    const appOf = async (manifestId: string): Promise<{ id: string, dir: string } | undefined> => manifestId === 'eth.demo.app' ? { id: 'demo', dir: appDir } : undefined
    const check = async (): ReturnType<typeof assertReleased> => assertReleased(tree, await declareBundle(tree, { check: true }), appOf)

    it('passes for an app with no record, and says nothing was compared', async () => {
      await expect(check()).resolves.toEqual({ status: 'no-record', id: 'demo' })
    })

    it('says nothing was compared for a tree whose manifest id belongs to no app', async () => {
      await writeFile(join(tree, MANIFEST), JSON.stringify({ ...await builtManifest(), id: 'eth.other.app' }, null, 2))
      await declareBundle(tree, { check: false })
      await expect(check()).resolves.toEqual({ status: 'not-an-app', manifestId: 'eth.other.app' })
    })

    it('passes for the released tree and refuses a changed one that kept the version', async () => {
      await releaseTree(target())
      await expect(check()).resolves.toMatchObject({ status: 'agrees', id: 'demo', version: '0.24.0.3' })
      await build({ version: '0.24.0.3', page: 'changed' })
      await expect(check()).rejects.toThrow(/orivon-port release demo/)
    })

    it('refuses the recorded content under another version', async () => {
      await releaseTree(target())
      await build({ version: '0.24.0.9' })
      await expect(check()).rejects.toThrow(/published as 0\.24\.0\.3.*release demo/)
    })

    it('refuses any build still at a seeded record\'s version, and passes one above it', async () => {
      await writeFile(join(appDir, 'published.json'), '{"version":"0.24.0.2"}')
      await expect(check()).rejects.toThrow(/release demo/)
      await build({ version: '0.24.0.3' })
      await expect(check()).resolves.toMatchObject({ status: 'agrees', recorded: '0.24.0.2' })
    })
  })
})

describe('the published record', () => {
  it('accepts a version alone, or with a hash and a pin', () => {
    expect(recordProblem({ version: '1.2.3' })).toBeUndefined()
    expect(recordProblem({ version: '1.2.3.4', contentHash: `sha256:${'0'.repeat(64)}`, upstreamRef: REF_A })).toBeUndefined()
  })

  it('refuses what cannot be ordered or compared', () => {
    expect(recordProblem({})).toMatch(/version/)
    expect(recordProblem({ version: '1.2.x' })).toMatch(/version/)
    expect(recordProblem({ version: '1', contentHash: 'abc' })).toMatch(/contentHash/)
    expect(recordProblem({ version: '1', upstreamRef: 'v1.0' })).toMatch(/upstreamRef/)
    expect(recordProblem({ version: '1', note: 'x' })).toMatch(/unknown field/)
    expect(recordProblem([])).toMatch(/object/)
  })

  it('names the file when it cannot be read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orivon-record-'))
    try {
      await writeFile(join(dir, 'published.json'), '{ nope')
      await expect(readRecord(dir)).rejects.toThrow(/published\.json is not JSON/)
      await writeFile(join(dir, 'published.json'), '{"version":"x"}')
      await expect(readRecord(dir)).rejects.toThrow(/published\.json "version"/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('versionProblem (check:version)', () => {
  it('refuses a record above the manifest', () => {
    expect(versionProblem('demo', { version: '0.24.0.3' }, '0.24.0.2')).toMatch(/only go up/)
    expect(versionProblem('demo', { version: '1.0.0.1' }, '0.9.9')).toMatch(/only go up/)
  })

  it('accepts a record equal to or below the manifest', () => {
    expect(versionProblem('demo', { version: '0.24.0.2' }, '0.24.0.2')).toBeUndefined()
    expect(versionProblem('demo', { version: '0.24.0.2' }, '0.24.0.3')).toBeUndefined()
    expect(versionProblem('demo', { version: '0.24.0.2' }, '0.24.0.2.1')).toBeUndefined()
  })

  it('refuses a manifest version that cannot be ordered', () => {
    expect(versionProblem('demo', { version: '1.0.0' }, '1.0.0-beta')).toMatch(/numbers separated by dots/)
    expect(versionProblem('demo', { version: '1.0.0' }, undefined)).toMatch(/numbers separated by dots/)
  })
})

describe('publishProblem', () => {
  const hash = `sha256:${'1'.repeat(64)}`
  it('wants the recorded version for the recorded content and a higher one for anything else', () => {
    expect(publishProblem('demo', { version: '1.0.1', contentHash: hash }, '1.0.1', hash)).toBeUndefined()
    expect(publishProblem('demo', { version: '1.0.1', contentHash: hash }, '1.0.2', hash)).toMatch(/release demo/)
    expect(publishProblem('demo', { version: '1.0.1', contentHash: hash }, '1.0.1', `sha256:${'2'.repeat(64)}`)).toMatch(/release demo/)
    expect(publishProblem('demo', { version: '1.0.1', contentHash: hash }, '1.0.2', `sha256:${'2'.repeat(64)}`)).toBeUndefined()
  })
})

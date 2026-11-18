// What the Worker takes of the 5chan board manager: the page sort a board's bump limit lives in is registered on the RPC server,
// the board manager's logger hands its lines to the Worker, and the bundle step reads the manager's own TypeScript with four
// of its imports changed to what the Worker has, and fails when the one line it rewrites is gone.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { boardManagerSource, boardManagerVersion } from '../../build/board-manager.mjs'
import Logger from '../worker/board-manager-logger.js'
import { routeBoardLog } from '../worker/diagnostics.js'
import { desktopPkcOptions, PAGE_SORTS } from '../worker/pkc-options.js'

const NODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const esbuild = createRequire(join(NODE_DIR, 'package.json'))('esbuild') as typeof import('esbuild')
const SORT = '@pkcprotocol/active-page-sort'

describe('the page sort', () => {
  const options = () => desktopPkcOptions({ dataPath: '/files/pkc', kuboUrl: 'http://127.0.0.1:50019' })

  it('is registered on the RPC server under its package name, the name a board\'s settings and the board manager use', () => {
    expect(Object.keys(options().pageSorts)).toEqual([SORT])
    expect(typeof options().pageSorts[SORT]).toBe('function')
    expect(Object.isFrozen(PAGE_SORTS)).toBe(true)
    expect(options().pageSorts).not.toBe(options().pageSorts)
  })

  it('gives the sort the board manager\'s bump limit is written to: past `bumpLimit` replies a thread stops rising', () => {
    const factory = options().pageSorts[SORT] as (args: { pageSortSettings: Record<string, unknown> }) => { sortName: string, scope: string, score: (args: Record<string, unknown>) => number }
    const replies = [101, 102, 103, 104, 105].map((timestamp) => ({ comment: { timestamp, content: 'hello', cid: `c${String(timestamp)}` }, commentUpdate: {} }))
    const limited = factory({ pageSortSettings: { name: SORT, options: { bumpLimit: '3' } } })
    const unlimited = factory({ pageSortSettings: { name: SORT } })
    expect(limited).toMatchObject({ sortName: 'active', scope: 'posts' })
    expect(limited.score({ comment: { timestamp: 100 }, options: {}, replies })).toBe(103)
    expect(unlimited.score({ comment: { timestamp: 100 }, options: {}, replies })).toBe(105)
  })

  it('leaves everything a board with no such setting uses as it was: the other options are the ones the desktop clients have', () => {
    const { pageSorts, ...rest } = options()
    expect(Object.keys(pageSorts)).toEqual([SORT])
    expect(Object.keys(rest).sort()).toEqual(['dataPath', 'httpRoutersOptions', 'kuboRpcClientsOptions', 'nameResolvers'])
    expect(rest.httpRoutersOptions).toHaveLength(4)
    expect(rest.nameResolvers).toHaveLength(6)
  })
})

describe('the board manager\'s logger', () => {
  const scope = globalThis as Record<string, any>
  afterEach(() => { delete scope['__bitsocialBoardLog'] })

  it('hands the Worker every log and error line and drops traces, as pkc-logger\'s calls are made', () => {
    const lines: string[] = []
    routeBoardLog(scope, (line) => { lines.push(line) }, (text) => text.replaceAll('KEY', '<key>'))
    const log = Logger('bitsocial:5chan-board-manager:archiver')
    log('archiving thread bafy (capacity)')
    log.error(`failed to archive ${String(new Error('boom'))} at ws://h/KEY`)
    log.trace('never')
    expect(lines).toEqual(['board manager: archiving thread bafy (capacity)', 'board manager error: failed to archive Error: boom at ws://h/<key>'])
  })

  it('says nothing when the Worker has not set where it goes, and has the rest of pkc-logger\'s surface', () => {
    const log = Logger('a:b')
    expect(() => { log('x'); log.error('y') }).not.toThrow()
    expect(Logger.enabled('a:b')).toBe(false)
    expect(() => { Logger.enable('a'); Logger.disable() }).not.toThrow()
  })
})

describe('the board manager\'s bundle', () => {
  async function bundle (pkcJs: 'bundle' | 'external') {
    const result = await esbuild.build({
      entryPoints: [join(NODE_DIR, 'worker', 'board-manager-entry.js')], bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent', metafile: true,
      plugins: [boardManagerSource({ version: await boardManagerVersion(), pkcJs })], ...(pkcJs === 'bundle' ? { external: ['@pkcprotocol/pkc-js/*', 'better-sqlite3'] } : {})
    })
    return { text: result.outputFiles[0]!.text, inputs: Object.keys(result.metafile.inputs) }
  }

  it('reads the manager\'s TypeScript and exports what the Worker takes of it', async () => {
    const { text, inputs } = await bundle('external')
    expect(inputs.filter((path) => path.includes('5chan-board-manager/src/')).map((path) => path.split('/').at(-1)).sort()).toEqual(['board-manager.ts', 'communities.ts', 'config-manager.ts', 'defaults.ts', 'multi-config.ts', 'page-sorts.ts', 'pkc-rpc.ts', 'state.ts'])
    expect(text).toMatch(/export \{[^}]*startBoardManager[^}]*\}/)
    expect(text).toMatch(/export \{[^}]*resolveBoardManagerOptions[^}]*\}/)
  })

  it('has no chokidar, no CLI, no logger package, no lock library and no file of the user\'s folders: each is the Worker\'s own or left out', async () => {
    const { text, inputs } = await bundle('external')
    expect(inputs.join('\n')).not.toMatch(/chokidar|oclif|env-paths\/|pkc-logger|proper-lock-file|board-managers\.ts|commands\//)
    expect(inputs.some((path) => path.endsWith('worker/board-manager-logger.js'))).toBe(true)
    expect(inputs.some((path) => path.endsWith('worker/workarounds/process-lock.js'))).toBe(true)
    expect(text).not.toMatch(/from "(chokidar|@oclif|env-paths|@pkcprotocol\/pkc-logger|@pkcprotocol\/proper-lock-file)/)
  })

  it('reads the package version in place of the `createRequire` line, which a bundle has no package.json for', async () => {
    const { text } = await bundle('external')
    expect(text).toContain(`var version = ${JSON.stringify(await boardManagerVersion())};`)
    expect(text).not.toContain("require('../package.json')")
  })

  it('takes pkc-js\'s `dist/bundled/index.js`, whose chunks the RPC server holds, not the package\'s compile-cache entry', async () => {
    const external = await bundle('external')
    expect(external.text).toMatch(/import PKC from "[^"]*@pkcprotocol\/pkc-js\/dist\/bundled\/index\.js"/)
    expect(external.text).not.toContain('index-with-compile-cache')
    const bundled = await bundle('bundle')
    expect(bundled.inputs.some((path) => path.endsWith('pkc-js/dist/bundled/index.js'))).toBe(true)
    expect(bundled.text).not.toContain('index-with-compile-cache')
  })

  it('fails the build, naming the file, when the line it rewrites is not in pkc-rpc.ts', async () => {
    // the plugin registers its stub's loader first and the file loader after it
    const callbacks: Array<(args: { path: string }) => Promise<unknown>> = []
    boardManagerSource({ version: '9.9.9' }).setup({ onResolve () {}, onLoad: (_options: unknown, callback: (args: { path: string }) => Promise<unknown>) => { callbacks.push(callback) } } as never)
    const dir = await mkdtemp(join(tmpdir(), 'bitsocial-bm-build-'))
    try {
      const path = join(dir, '5chan-board-manager', 'src', 'pkc-rpc.ts')
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'export const nothing = 1\n')
      await expect(callbacks.at(-1)!({ path })).rejects.toThrow(/text not found in .*pkc-rpc\.ts: const require = createRequire/)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

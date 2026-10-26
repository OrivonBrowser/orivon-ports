// The build's decisions, each gate handed the violation it exists to catch.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkMetafile } from '../../../src/build/esbuild-kit.mjs'
import {
  answeredChannels, BUNDLE_FILE, FORBIDDEN_PREFIXES, REFUSED_NATIVE, refusedNativeSource, REQUIRED_INPUTS, sentChannels, START_FILE,
  PACED_FS, PREFS_KEY, prefsKeyProblems, startHtml, startScript, STAND_INS, unansweredChannels
} from './build-plan.js'

const UPSTREAM = [
  '<!doctype html>', '<html lang="en">', '  <head>', '    <meta charset="UTF-8" />',
  '    <script type="module" crossorigin src="./assets/index-CQEqaWfm.js"></script>',
  '    <link rel="modulepreload" crossorigin href="./assets/vendor-react-CGcIVk5f.js">', '  </head>', '  <body><div id="root"></div></body>', '</html>'
].join('\n')

describe('startHtml', () => {
  it('puts the bundle first in the head and hands the entry module to the start script', () => {
    const { html, entry } = startHtml(UPSTREAM)
    expect(entry).toBe('./assets/index-CQEqaWfm.js')
    expect(html.indexOf(`<script src="${BUNDLE_FILE}"></script>`)).toBeGreaterThan(html.indexOf('<head>'))
    expect(html.indexOf(`src="${BUNDLE_FILE}"`)).toBeLessThan(html.indexOf(`src="${START_FILE}"`))
    expect(html).toContain(`<script src="${START_FILE}"></script>`)
    expect(html).not.toContain('type="module"')
    expect(html).toContain('rel="modulepreload"')
  })

  it('leaves a document it already rewrote alone, because prepare may run twice', () => {
    const once = startHtml(UPSTREAM).html
    expect(startHtml(once)).toEqual({ html: once, entry: null })
  })

  it('refuses a document whose shape changed, rather than serving a page nothing starts', () => {
    expect(() => startHtml(UPSTREAM.replace('type="module" crossorigin ', ''))).toThrow(/upstream's document changed shape/)
  })
})

describe('startScript', () => {
  const run = (text: string, globals: Record<string, unknown>) => new Function(...Object.keys(globals), text.replace('import(entry)', 'globals.load(entry)'))(...Object.values(globals))

  it('waits for the bundle\'s start-up work, then loads the entry module it was given', () => {
    const text = startScript('./assets/index-CQEqaWfm.js')
    expect(text).toContain('globalThis.__zennotesReady')
    expect(text).toContain('"./assets/index-CQEqaWfm.js"')
  })

  it('reads the entry\'s address from the document, not from the directory the script sits in', async () => {
    const loaded: string[] = []
    const globals = { globalThis: { __zennotesReady: Promise.resolve() }, document: { baseURI: 'https://example.org/ipfs/bafy/index.html' }, console, globals: { load: (path: string) => { loaded.push(path) } } }
    run(startScript('./assets/index-CQEqaWfm.js'), globals)
    await Promise.resolve()
    await Promise.resolve()
    expect(loaded).toEqual(['https://example.org/ipfs/bafy/assets/index-CQEqaWfm.js'])
  })

  it('still starts the renderer if the start-up work was never begun, and does not start it when that work failed', async () => {
    const started: string[] = []
    const failures: unknown[] = []
    const globals = (ready?: Promise<void>) => ({ globalThis: { __zennotesReady: ready }, document: { baseURI: 'https://example.org/' }, console: { error: (...args: unknown[]) => { failures.push(args) } }, globals: { load: (path: string) => { started.push(path) } } })
    run(startScript('./x.js'), globals())
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual(['https://example.org/x.js'])
    const failed = Promise.reject(new Error('no config'))
    run(startScript('./y.js'), globals(failed))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(['https://example.org/x.js'])
    expect(failures).toHaveLength(1)
  })
})

describe('the bundle gate', () => {
  const complete = REQUIRED_INPUTS.map(({ path }) => path)
  const gate = (inputs: string[]): string[] => checkMetafile(inputs, { required: REQUIRED_INPUTS, forbidden: FORBIDDEN_PREFIXES })

  it('passes a bundle holding the preload, the vault module and the settings module', () => {
    expect(gate(complete)).toEqual([])
  })

  it('names a missing piece of upstream', () => {
    expect(gate(complete.filter((path) => !path.endsWith('vault.ts')))).toEqual([expect.stringMatching(/missing apps\/desktop\/src\/main\/vault\.ts.*reads and writes the notes/)])
  })

  it('names a refused native module, or a stand-in that did not take effect', () => {
    expect(gate([...complete, 'node_modules/keytar/lib/keytar.js'])).toEqual([expect.stringMatching(/holds node_modules\/keytar.*native module/)])
    expect(gate([...complete, 'node_modules/chokidar/index.js'])).toEqual([expect.stringMatching(/holds node_modules\/chokidar.*no-watch/)])
    expect(gate([...complete, 'node_modules/electron/index.js'])).toEqual([expect.stringMatching(/holds node_modules\/electron.*electron\.js/)])
  })

  it('forbids every stand-in\'s own package', () => {
    const forbidden = new Set(FORBIDDEN_PREFIXES.map(({ prefix }) => prefix))
    for (const name of Object.keys(STAND_INS)) expect(forbidden.has(`node_modules/${name}/`), name).toBe(true)
  })
})

describe('refusedNativeSource', () => {
  it('throws on load as a module that is not installed, which upstream\'s try/catch expects', () => {
    for (const name of REFUSED_NATIVE) {
      expect(() => new Function(refusedNativeSource(name))()).toThrow(expect.objectContaining({ code: 'MODULE_NOT_FOUND', message: expect.stringContaining(name) }))
    }
  })
})

describe('the channels', () => {
  const bridge = ['main-process.js', 'channels.js', 'vault-calls.js'].map((name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'))
  const preload = [
    "ipcRenderer.invoke(IPC.VAULT_READ_NOTE, relPath)",
    "ipcRenderer.invoke(\n    IPC.VAULT_LIST_NOTES_STREAM,\n    request)",
    "ipcRenderer.send(IPC.APP_RENDERER_READY)",
    "ipcRenderer.sendSync(IPC.CONFIG_GET_SYNC)",
    "ipcRenderer.on(IPC.VAULT_ON_CHANGE, listener)"
  ].join('\n')

  it('reads what the preload sends to main, and not what main sends to it', () => {
    expect([...sentChannels(preload)].sort()).toEqual(['APP_RENDERER_READY', 'CONFIG_GET_SYNC', 'VAULT_LIST_NOTES_STREAM', 'VAULT_READ_NOTE'])
  })

  it('finds every one of those in the bridge\'s own sources', () => {
    expect(unansweredChannels(sentChannels(preload), answeredChannels(...bridge))).toEqual([])
  })

  it('names a channel upstream sends that nothing in the bridge names', () => {
    const sent = sentChannels("ipcRenderer.invoke(IPC.VAULT_READ_NOTE, p)\nipcRenderer.invoke(IPC.VAULT_ABSORB_NOTE, p)")
    expect(unansweredChannels(sent, answeredChannels(...bridge))).toEqual(['VAULT_ABSORB_NOTE'])
  })
})

describe('prefsKeyProblems', () => {
  it('is quiet while upstream\'s store keeps its preferences under the key the first run seeds', () => {
    expect(prefsKeyProblems(`const A = 1\nconst PREFS_KEY = '${PREFS_KEY}'\n`)).toEqual([])
  })

  it('names the key when upstream moves its preferences, so a first run is not seeded where nothing reads it', () => {
    expect(prefsKeyProblems("const PREFS_KEY = 'zen:prefs:v3'")).toEqual([expect.stringContaining(PREFS_KEY)])
  })
})

describe('the paced file module', () => {
  it('stands in for node:fs and node:fs/promises, and each stand-in is a file of the bridge', () => {
    expect(Object.keys(PACED_FS)).toEqual(['node:fs', 'node:fs/promises'])
    for (const file of Object.values(PACED_FS)) expect(() => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')).not.toThrow()
  })
})

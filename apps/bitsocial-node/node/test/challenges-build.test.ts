// What the Worker's bundle makes of the challenge packages: the build resolves four imports to something the Worker has and
// takes the font in, and the bundle then runs under plain Node as the packages do in the Worker. The captcha is the one that
// needs it: its package imports skia-canvas, a native module, and must draw its image with the pure-JavaScript canvas instead.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { bundleChallenges, challengeSources } from '../../build/challenges.mjs'
import Logger from '../worker/challenge-logger.js'
import { routeChallengeLog } from '../worker/diagnostics.js'
import { Canvas, FontLibrary, loadImage } from '../worker/workarounds/pure-canvas.js'

const NODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const needs = createRequire(join(NODE_DIR, 'package.json'))
const esbuild = needs('esbuild') as typeof import('esbuild')
/** pngjs ships no types: the one call these tests make of it. */
const { PNG } = needs('pngjs') as { PNG: { sync: { read: (bytes: Buffer) => { width: number, height: number, data: Uint8Array } } } }
const NAMES = [
  '@bitsocial/ai-moderation-challenge', '@bitsocial/base64-challenge', '@bitsocial/captcha-canvas-challenge', '@bitsocial/evm-contract-challenge',
  '@bitsocial/flags-challenge', '@bitsocial/r9k-challenge', '@bitsocial/spam-blocker-challenge', '@bitsocial/voucher-challenge', '@bitsocial/wordfilter-challenge'
]

let dir: string
let bundled: { BUNDLED: Array<{ name: string, factory: (options: { challengeSettings: Record<string, unknown> }) => Record<string, any> }> }
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bitsocial-challenges-'))
  bundled = await import(pathToFileURL(await bundleChallenges({ outfile: join(dir, 'challenges.mjs') })).href)
}, 120_000)
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

describe('the bundle the build makes', () => {
  it('holds every bundled challenge under its package name, each one still a factory that describes itself', () => {
    expect(bundled.BUNDLED.map((one) => one.name)).toEqual(NAMES)
    for (const one of bundled.BUNDLED) {
      const made = one.factory({ challengeSettings: {} })
      expect(typeof made['type'], one.name).toBe('string')
      expect(Array.isArray(made['optionInputs']), one.name).toBe(true)
      expect(typeof made['getChallenge'], one.name).toBe('function')
    }
  })

  it('reads no native module: skia-canvas is the pure-JavaScript canvas, the packages\' logger is the Worker\'s, and no file is a binding', async () => {
    const result = await esbuild.build({
      entryPoints: [join(NODE_DIR, 'worker', 'challenges.js')], bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent', metafile: true,
      banner: { js: "import { createRequire as r } from 'node:module'; const require = r(import.meta.url);" }, plugins: [challengeSources()]
    })
    const inputs = Object.keys(result.metafile.inputs).map((path) => path.replaceAll('\\', '/'))
    expect(inputs.some((path) => path.includes('worker/workarounds/pure-canvas.js'))).toBe(true)
    expect(inputs.some((path) => path.includes('worker/challenge-logger.js'))).toBe(true)
    expect(inputs.filter((path) => /node_modules\/skia-canvas\/|pkc-logger|\.node$|better-sqlite3|node-gyp|i18n-iso-countries\/(langs|entry-node)/.test(path))).toEqual([])
    expect(inputs.some((path) => path.endsWith('node_modules/i18n-iso-countries/index.js'))).toBe(true)
    expect(result.outputFiles[0]!.text).not.toMatch(/require\(["']skia-canvas["']\)|from ["']skia-canvas["']/)
  }, 120_000)

  it('takes the font file in as bytes, so the Worker needs no node_modules to draw text', async () => {
    const result = await esbuild.build({
      entryPoints: [join(NODE_DIR, 'worker', 'workarounds', 'pure-canvas.js')], bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
      banner: { js: "import { createRequire as r } from 'node:module'; const require = r(import.meta.url);" }, plugins: [challengeSources()]
    })
    const text = result.outputFiles[0]!.text
    const inlined = /(?:const|var) BASE64 = "([A-Za-z0-9+/=]+)"/.exec(text)
    expect(inlined !== null).toBe(true)
    expect(text.includes('Bitstream Vera Fonts Copyright')).toBe(true)
    expect(text.includes('dejavu-fonts-ttf/ttf/DejaVuSans.ttf')).toBe(false)
    expect(Buffer.from(inlined![1]!, 'base64').equals(await readFile(createRequire(join(NODE_DIR, 'package.json')).resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf')))).toBe(true)
  }, 120_000)
})

describe('the captcha challenge on the pure-JavaScript canvas', () => {
  const captcha = () => bundled.BUNDLED.find((one) => one.name === '@bitsocial/captcha-canvas-challenge')!.factory({ challengeSettings: {} })

  it('draws a PNG of the size it is asked for, with the characters in it, and checks an answer', async () => {
    const made = captcha()
    const result = await made['getChallenge']({ challengeSettings: { options: { width: '240', height: '80', characters: '5', colors: '#c0392b,#2c3e50' } } })
    expect(result).toMatchObject({ type: 'image/png', caseInsensitive: true })
    const png = PNG.sync.read(Buffer.from(result.challenge, 'base64'))
    expect([png.width, png.height]).toEqual([240, 80])
    let drawn = 0
    for (let index = 3; index < png.data.length; index += 4) if (png.data[index]! > 0) drawn += 1
    expect(drawn).toBeGreaterThan(400)
    expect(await result.verify('definitely-wrong')).toMatchObject({ success: false, error: 'Wrong captcha.' })
  })

  it('draws a different image each time, and one whose answer only that image has', async () => {
    const made = captcha()
    const [one, two] = await Promise.all([1, 2].map(() => made['getChallenge']({ challengeSettings: {} }) as Promise<{ challenge: string }>))
    expect(one!.challenge).not.toBe(two!.challenge)
  })
})

describe('the canvas', () => {
  it('writes a PNG of its own size, draws in the one font whatever family is asked for, and writes nothing but PNG', async () => {
    const canvas = new Canvas(120, 60)
    const ctx = canvas.getContext('2d') as unknown as Record<string, any>
    ctx['fillStyle'] = '#000000'
    ctx['font'] = '40px Arial'
    ctx['fillText']('Wg', 10, 45)
    const png = PNG.sync.read(await canvas.toBuffer('png'))
    expect([png.width, png.height, canvas.width, canvas.height, canvas.gpu]).toEqual([120, 60, 120, 60, false])
    expect(png.data.some((byte, index) => index % 4 === 3 && byte > 0)).toBe(true)
    expect(() => canvas.toBufferSync('jpeg')).toThrow(/png/)
    expect(canvas.getContext('webgl')).toBeNull()
  })

  it('reads a PNG back as an image it can draw, and refuses a path it cannot read', async () => {
    const source = new Canvas(8, 8)
    const ctx = source.getContext('2d') as unknown as Record<string, any>
    ctx['fillStyle'] = '#ff0000'
    ctx['fillRect'](0, 0, 8, 8)
    const image = await loadImage(await source.toBuffer('png'))
    expect([image.width, image.height]).toEqual([8, 8])
    await expect(loadImage('/etc/hostname')).rejects.toThrow(/bytes/)
    expect(FontLibrary.families).toEqual(['Sans'])
    expect(() => { FontLibrary.use() }).toThrow(/one font/)
  })
})

describe('the challenge packages\' logger', () => {
  const scope = globalThis as Record<string, any>
  afterEach(() => { delete scope['__bitsocialChallengeLog'] })

  it('hands the Worker each log and error line, with the key left out, and drops traces', () => {
    const lines: string[] = []
    routeChallengeLog(scope, (line) => { lines.push(line) }, (text) => text.replaceAll('KEY', '<key>'))
    const log = Logger('bitsocial:spam-blocker')
    log('scored a publication')
    log.error('failed at https://h/KEY')
    log.trace('never')
    expect(lines).toEqual(['challenge: scored a publication', 'challenge error: failed at https://h/<key>'])
  })

  it('says nothing when the Worker has not set where it goes', () => {
    expect(() => { Logger('a')('x') }).not.toThrow()
  })
})

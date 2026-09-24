import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MANIFEST_PATH, bundleRoot, canonicalPathOf, canonicalPathProblem, collisionKey, findCollision, leafOf, leafOfFile
} from './bundle-hash.ts'

// V1-V6 are orivon-mvp's frozen vectors (docs/architecture/bundle-hash.md),
// copied, never regenerated: a failing row means this implementation is wrong.

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8')
const rootOf = (entries: ReadonlyArray<readonly [string, string]>): string =>
  bundleRoot(entries.map(([path, content]) => ({ path, leaf: leafOf(path, utf8(content)) }))).root

const V1: ReadonlyArray<readonly [string, string]> = [
  ['/.well-known/orivon.json', '{"orivonApiVersion":0}'],
  ['/index.html', '<!doctype html><title>a</title>'],
  ['/app.js', 'console.log(1)']
]
const V1_ROOT = 'sha256:2ff5baaa794301118be4270755686fd1438501332ab3b1a199af90815ca4c4fd'

describe('frozen vectors', () => {
  it('V1: three files, including the manifest', () => {
    expect(rootOf(V1)).toBe(V1_ROOT)
  })

  it('V2: the order the files are supplied in does not matter', () => {
    expect(rootOf([V1[2]!, V1[0]!, V1[1]!])).toBe(V1_ROOT)
  })

  it('V3: a single leaf, whose root is not its own digest', () => {
    expect(rootOf([[MANIFEST_PATH, '{}']])).toBe('sha256:d7cc8d092809e3f091d7f11a7dcccfceba519540a5f5730f80068b371b358e25')
    expect(leafOf(MANIFEST_PATH, utf8('{}'))).toBe('sha256:4c1f4a74edebb25f62e547b5741793f5f759fdadd631fac073557ef8e78e5deb')
  })

  // Not legal bundles (no manifest), so through the raw functions only.
  it('V4: length-prefixing keeps "a"+"bc" apart from "ab"+"c"', () => {
    expect(rootOf([['/a', 'bc']])).toBe('sha256:295023c3aee9987672b4ea79cf418b70355f1ed3fca9c35242a7e9d63a772c65')
    expect(rootOf([['/ab', 'c']])).toBe('sha256:cb8d15aeab6efe4cce6370edea69ec60dc5fb8be40cda93f9e9b43f7c0749d26')
  })

  it('V5: non-ASCII paths, percent-encoded as the parser leaves them', () => {
    expect(canonicalPathOf('\u{10000}.js')).toEqual({ ok: true, path: '/%F0%90%80%80.js' })
    expect(canonicalPathOf('.js')).toEqual({ ok: true, path: '/%EE%80%80.js' })
    expect(rootOf([
      ['/.well-known/orivon.json', '{"orivonApiVersion":0}'],
      ['/%F0%90%80%80.js', 'x'],
      ['/%EE%80%80.js', 'y']
    ])).toBe('sha256:9aebeec88db79ddc4244d8026f0f93aee26d8bcd686da283c77db35617467af9')
  })

  it('V6: the per-path leaf table, in the order the root was computed in', () => {
    const tree = bundleRoot(V1.map(([path, content]) => ({ path, leaf: leafOf(path, utf8(content)) })))
    expect(tree.root).toBe(V1_ROOT)
    expect(tree.leaves).toEqual([
      { path: '/.well-known/orivon.json', leaf: 'sha256:612c226ad5f32daa98f31de474342d9f6215339cc7f607b5052bbf57e0422872' },
      { path: '/app.js', leaf: 'sha256:fe2c01feec61bdeccff4b903bfca12c534a3c770d053bcdb6e7171ec60a41116' },
      { path: '/index.html', leaf: 'sha256:e64a531c45ee108a04ea6ba8d43eb74810b50142a6f68d6d37a4f73389cc6975' }
    ])
  })
})

describe('leafOfFile', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-leaf-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('streams to the same digest as the bytes in hand', async () => {
    const content = Buffer.alloc(3 * 1024 * 1024 + 7, 0x61)
    await writeFile(join(dir, 'big.js'), content)
    expect(await leafOfFile('/big.js', join(dir, 'big.js'), content.length)).toBe(leafOf('/big.js', content))
  })

  it('refuses a file whose size is not the one measured', async () => {
    await writeFile(join(dir, 'a.js'), 'abc')
    await appendFile(join(dir, 'a.js'), 'd')
    await expect(leafOfFile('/a.js', join(dir, 'a.js'), 3)).rejects.toThrow(/changed size/)
    await expect(leafOfFile('/a.js', join(dir, 'a.js'), 5)).rejects.toThrow(/changed size/)
  })
})

describe('canonicalPathOf', () => {
  it.each([
    ['index.html', '/index.html'],
    ['logo@2x.png', '/logo@2x.png'],
    ['a b.js', '/a%20b.js'],
    ['ä.js', '/%C3%A4.js'],
    ['x#y.js', '/x%23y.js'],
    ['q?.js', '/q%3F.js'],
    ['100%.js', '/100%25.js'],
    ['%41.js', '/%2541.js'],
    [join('img', 'a b', 'c.png'), '/img/a%20b/c.png'],
    // Pins Node's current WHATWG parser, which added "^" to the path percent-encode set.
    ['a^b.js', '/a%5Eb.js'],
    ['CONFIG.js', '/CONFIG.js'],
    ['..foo.js', '/..foo.js']
  ])('%j is served at %j', (file, path) => {
    expect(canonicalPathOf(file)).toEqual({ ok: true, path })
  })

  it.each([
    ['a\tb.js', /rewrites/],
    ['a\nb.js', /rewrites/],
    ['a\rb.js', /rewrites/],
    ['trail.js ', /rewrites/],
    ['a\\b.js', /rewrites/],
    ['a/../b.js', /rewrites/],
    ['CON.js', /device/],
    ['nul', /device/],
    ['com1.txt', /device/],
    ['dir/PRN.js', /device/],
    ['LPT9', /device/],
    ['a.js.', /dot or a space/],
    ['dir./b.js', /dot or a space/],
    ['dir /b.js', /dot or a space/],
    ['a\u0001b.js', /control/],
    ['a\u0085b.js', /control/],
    ['a\u007Fb.js', /control/],
    ['a\u0000b.js', /control/],
    ['a:b.js', /Windows/],
    ['a|b.js', /Windows/],
    ['a//b.js', /empty segment/],
    ['', /root/],
    [`${'d'.repeat(200)}/`.repeat(6) + 'x.js', /1024 bytes/]
  ])('refuses %j', (file, reason) => {
    const result = canonicalPathOf(file)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problem).toMatch(reason)
  })

  it('refuses a name that is 1024 bytes only once it is encoded', () => {
    expect(canonicalPathOf('ä'.repeat(200)).ok).toBe(false)
  })
})

describe('canonicalPathProblem', () => {
  // The rows of orivon-mvp's rejection table that a file name cannot reach,
  // held to the same answer on the canonical string itself.
  it.each([
    'a.js', '/a b.js', '/ä.js', '/%2e%2e/x.js', '/a?b.js', '/a#b.js', '/%zz.js', '/%.js',
    '/%00.js', '/..%2F..%2Fevil.js', '/%2E/b.js', '/a%5Cb.js', '/a%3Ahidden.js', '/a%7Cb.js',
    '/a.js%20', '/a/', '/', '/a/./b.js', '/a/../b.js'
  ])('refuses %j', (path) => {
    expect(canonicalPathProblem(path)).not.toBeNull()
  })

  it.each([
    '/index.html', '/assets/index-CJ1a1Q2B.js', '/fonts/Inter%20Regular.woff2', '/img/logo@2x.png',
    '/a.b.c/d.e.f.js', '/%C3%A4.js', '/CONFIG.js', '/prnt.js'
  ])('accepts %j', (path) => {
    expect(canonicalPathProblem(path)).toBeNull()
  })
})

describe('collisions', () => {
  const pathOf = (file: string): string => {
    const result = canonicalPathOf(file)
    if (!result.ok) throw new Error(result.problem)
    return result.path
  }

  it.each([
    ['A.js', 'a.js'],
    ['café.js', 'café.js'],
    ['Ä.js', 'ä.js']
  ])('%j and %j name one file', (a, b) => {
    expect(findCollision([pathOf(a), pathOf(b)])).toEqual([pathOf(a), pathOf(b)])
  })

  // The key decodes first, as orivon-mvp's does, so the canonical strings
  // "/%41.js" and "/A.js" collide. A FILE named "%41.js" is served at
  // "/%2541.js", which decodes back to its own name and collides with nothing.
  it('decodes before folding, so only a real alias collides', () => {
    expect(collisionKey('/%41.js')).toBe(collisionKey('/A.js'))
    expect(findCollision([pathOf('%41.js'), pathOf('A.js')])).toBeNull()
  })

  it('catches a second manifest spelled differently', () => {
    expect(findCollision([MANIFEST_PATH, pathOf(join('.well-known', 'Orivon.json'))])).not.toBeNull()
  })
})

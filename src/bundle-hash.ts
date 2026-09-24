import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { sep } from 'node:path'

// The Orivon bundle hash, computed the way the client recomputes it. The
// construction, the path rules and the caps are specified in orivon-mvp's
// docs/architecture/bundle-hash.md and implemented there in
// src/broker/policy/{bundle-hash,canonical-path}.ts; everything here mirrors
// those, rule for rule, because a tree the client hashes differently is a
// tree it refuses. The frozen vectors in the test file are the proof.
//
// Nothing here may import from orivon-mvp: a port consumes the API, it is
// never built against the shell's source.

export const BUNDLE_HASH_VERSION = 'orivon-bundle-v1'
export const MANIFEST_PATH = '/.well-known/orivon.json'
export const DDOC_PATH = '/.well-known/orivon-ddoc.json'

export const MAX_BUNDLE_ENTRIES = 4096
export const MAX_ASSET_BYTES = 64 * 1024 * 1024
export const MAX_BUNDLE_BYTES = 512 * 1024 * 1024
export const MAX_PATH_BYTES = 1024

export interface Leaf {
  readonly path: string
  readonly leaf: string
}

function u32be (value: number): Buffer {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(value)
  return out
}

function framed (text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8')
  return Buffer.concat([u32be(bytes.length), bytes])
}

/** 0x00 || u32be(len path) || path || u64be(len content): everything a leaf hashes before its content. */
export function leafPrefix (path: string, byteLength: number): Buffer {
  const length = Buffer.alloc(8)
  length.writeBigUInt64BE(BigInt(byteLength))
  return Buffer.concat([Buffer.of(0x00), framed(path), length])
}

export function leafOf (path: string, content: Uint8Array): string {
  return `sha256:${createHash('sha256').update(leafPrefix(path, content.length)).update(content).digest('hex')}`
}

/**
 * The same leaf, streamed off disk. The length is hashed before the content,
 * so a file that changed size since it was measured must fail rather than
 * produce a digest of bytes nobody measured.
 */
export async function leafOfFile (path: string, file: string, byteLength: number): Promise<string> {
  const hash = createHash('sha256').update(leafPrefix(path, byteLength))
  let seen = 0
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
    seen += chunk.length
    if (seen > byteLength) break
    hash.update(chunk)
  }
  if (seen !== byteLength) throw new Error(`${file} changed size while it was being hashed (expected ${String(byteLength)} bytes)`)
  return `sha256:${hash.digest('hex')}`
}

/** Unsigned UTF-8 byte order, never the UTF-16 order `sort()` uses by default. */
export function compareUtf8 (a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/**
 * The root over leaves already digested, and the leaves in the order it was
 * computed in. Validates nothing: the rules are the caller's to apply first.
 */
export function bundleRoot (leaves: readonly Leaf[]): { readonly root: string, readonly leaves: readonly Leaf[] } {
  const sorted = [...leaves].sort((a, b) => compareUtf8(a.path, b.path))
  const hash = createHash('sha256').update(Buffer.of(0x01)).update(framed(BUNDLE_HASH_VERSION)).update(u32be(sorted.length))
  for (const { leaf } of sorted) hash.update(Buffer.from(leaf.slice('sha256:'.length), 'hex'))
  return { root: `sha256:${hash.digest('hex')}`, leaves: sorted }
}

const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/
const UNSAFE_DECODED_CHARS = /[\\:|]/
const TRAILING_DOT_OR_SPACE = /[. ]$/
const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i
const CANONICALISATION_BASE = 'https://canonicalisation.invalid'

function decodePercentEscapes (path: string): string | null {
  try {
    return decodeURIComponent(path)
  } catch {
    return null
  }
}

/**
 * Why the client would refuse `path` as a canonical asset path, or null when
 * it would not. Accepts and refuses exactly what orivon-mvp's
 * `isValidCanonicalPath` does, in the same order; the reason is this
 * repository's addition, so a refusal can say what to rename.
 */
export function canonicalPathProblem (path: string): string | null {
  if (path.length === 0 || !path.startsWith('/')) return 'it does not start with "/"'
  if (path.length > MAX_PATH_BYTES || Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES) return `it is longer than ${String(MAX_PATH_BYTES)} bytes once URL-encoded`
  if (CONTROL_CHARS.test(path)) return 'it holds a control character'
  let reDerived: string
  try {
    reDerived = new URL(path, CANONICALISATION_BASE).pathname
  } catch {
    return 'it is not a URL path'
  }
  if (reDerived !== path) return 'it is not in the form a URL parser produces'
  const decoded = decodePercentEscapes(path)
  if (decoded === null) return 'a percent-escape in it does not decode'
  if (CONTROL_CHARS.test(decoded)) return 'it holds a control character'
  if (UNSAFE_DECODED_CHARS.test(decoded)) return 'it holds "\\", ":" or "|", which Windows reads as a separator, a stream or nothing'
  if (decoded === '/') return 'it names the root rather than a file'
  for (const segment of decoded.split('/').slice(1)) {
    if (segment.length === 0) return 'it has an empty segment'
    if (segment === '.' || segment === '..') return 'it has a "." or ".." segment'
    if (TRAILING_DOT_OR_SPACE.test(segment)) return `"${segment}" ends in a dot or a space, which Windows strips`
    if (WINDOWS_DEVICE.test(segment.split('.')[0] ?? '')) return `"${segment}" is a Windows device name`
  }
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return 'it has a "." or ".." segment'
  return null
}

export type CanonicalPath =
  | { readonly ok: true, readonly path: string }
  | { readonly ok: false, readonly problem: string }

/**
 * A file's path relative to the served root, as the URL path the client
 * requests it at. Only `%`, `?` and `#` are escaped by hand -- the three the
 * parser would read as syntax -- and the parser does the rest, so nothing is
 * encoded that the client would not encode (see src/README.md).
 */
export function canonicalPathOf (relativePath: string): CanonicalPath {
  const raw = `/${relativePath.split(sep).join('/')}`
  const escaped = `/${relativePath.split(sep).map((segment) => segment.replace(/[%?#]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')}`
  let path: string
  try {
    path = new URL(escaped, CANONICALISATION_BASE).pathname
  } catch {
    return { ok: false, problem: 'it is not a URL path' }
  }
  // The parser drops tabs and newlines, trims trailing spaces and turns "\"
  // into "/" without complaint; a name that does not survive the round trip
  // is served under a different name than it has on disk.
  if (decodePercentEscapes(path) !== raw) return { ok: false, problem: 'a URL parser rewrites it (a tab, newline, backslash or trailing space)' }
  const problem = canonicalPathProblem(path)
  return problem === null ? { ok: true, path } : { ok: false, problem }
}

/** Percent-decode, then NFC, then fold case: orivon-mvp's `collisionKey`. */
export function collisionKey (path: string): string {
  return (decodePercentEscapes(path) ?? path).normalize('NFC').toLowerCase()
}

/** The first two paths that name one file on a case- or normalisation-insensitive disk. */
export function findCollision (paths: readonly string[]): readonly [string, string] | null {
  const seen = new Map<string, string>()
  for (const path of paths) {
    const key = collisionKey(path)
    const earlier = seen.get(key)
    if (earlier !== undefined) return [earlier, path]
    seen.set(key, path)
  }
  return null
}

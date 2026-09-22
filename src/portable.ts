import { open, readFile, readdir } from 'node:fs/promises'
import { brotliDecompressSync } from 'node:zlib'
import { join, relative } from 'node:path'

// What a plain static host can and cannot do for a file. An IPFS gateway, a
// bucket behind a CDN and src/serve.ts all answer from a file's name and its
// bytes; none of them knows that `en-US.json.br` must arrive under
// `Content-Encoding: br` before a browser will parse it. A build that emits
// one runs only where something sets that header by hand, which is a port
// that is not portable.
//
// The test is on content, never on the name: a file NAMED `.br` that holds
// plain JSON is exactly the shape that passes.

const MAX_DECOMPRESSED = 64 * 1024 * 1024

const MAGIC: ReadonlyArray<{ readonly encoding: string, readonly bytes: readonly number[] }> = [
  { encoding: 'gzip', bytes: [0x1f, 0x8b] },
  { encoding: 'zstd', bytes: [0x28, 0xb5, 0x2f, 0xfd] }
]

export interface EncodedFile {
  readonly path: string
  readonly encoding: string
}

async function head (path: string, length: number): Promise<Buffer> {
  const file = await open(path)
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await file.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

/**
 * Brotli streams carry no magic number, so the only test is to decode one.
 * That is confined to files named `.br`: decoding every asset on the chance
 * it is secretly brotli would be slow and would invite false positives.
 */
function isBrotli (bytes: Buffer): boolean {
  try {
    brotliDecompressSync(bytes, { maxOutputLength: MAX_DECOMPRESSED })
    return true
  } catch {
    return false
  }
}

async function encodingOf (path: string): Promise<string | null> {
  const magic = await head(path, 4)
  for (const { encoding, bytes } of MAGIC) {
    if (bytes.length <= magic.length && bytes.every((byte, index) => magic[index] === byte)) return encoding
  }
  if (path.endsWith('.br') && isBrotli(await readFile(path))) return 'br'
  return null
}

export async function findEncodedFiles (root: string): Promise<EncodedFile[]> {
  const found: EncodedFile[] = []
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    const encoding = await encodingOf(path)
    if (encoding !== null) found.push({ path: relative(root, path), encoding })
  }
  return found
}

export function encodedFilesMessage (label: string, found: readonly EncodedFile[]): string {
  const shown = found.slice(0, 5).map(({ path, encoding }) => `  ${path} (${encoding})`)
  if (found.length > shown.length) shown.push(`  ...and ${String(found.length - shown.length)} more`)
  return [
    `[${label}] the prepared app holds ${String(found.length)} pre-compressed file(s):`,
    ...shown,
    'Each is readable only under a Content-Encoding header, and a plain static host',
    'derives no such header. Emit them decompressed -- under whatever name the app',
    'fetches, the name is free -- or this app runs on this server and nowhere else.'
  ].join('\n')
}

export async function assertHostAgnostic (root: string, label: string): Promise<void> {
  const found = await findEncodedFiles(root)
  if (found.length > 0) throw new Error(encodedFilesMessage(label, found))
}

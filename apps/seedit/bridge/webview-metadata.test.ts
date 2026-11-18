// stripMetadata of webview-upload.js on images built here byte by byte: what a camera or an editor
// leaves in a JPEG, a PNG and a WebP goes, what draws the picture stays (a photo's rotation too), and
// a file that is not one of the three, or that is cut short, goes up exactly as it was.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./webview-upload.js', import.meta.url), 'utf8')
const window: Record<string, unknown> = {}
vm.runInNewContext(source, { window, document: {}, setTimeout, clearTimeout, Date, console, btoa, atob, File, Uint8Array })
const stripMetadata = (window['orivonWebviewUpload'] as { stripMetadata: (file: File) => Promise<File> }).stripMetadata

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0))
const be16 = (value: number) => [value >> 8, value & 0xff]
const be32 = (value: number) => [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
const le32 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24]
const bytesOf = (...parts: number[][]) => Uint8Array.from(parts.flat())
const textOf = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1')

async function stripped (bytes: Uint8Array, name = 'a.bin', type = 'application/octet-stream') {
  const file = new File([bytes], name, { type })
  const out = await stripMetadata(file)
  return { file, out, bytes: new Uint8Array(await out.arrayBuffer()) }
}

// --- JPEG
const segment = (marker: number, payload: number[]) => [0xff, marker, ...be16(payload.length + 2), ...payload]
/** An Exif block, big-endian, whose first directory holds the orientation and a made-up location. */
const exif = (orientation: number) => segment(0xe1, [
  ...ascii('Exif'), 0, 0, 0x4d, 0x4d, 0, 42, 0, 0, 0, 8,
  0, 2, 0x01, 0x12, 0, 3, 0, 0, 0, 1, ...be16(orientation), 0, 0, 0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0,
  ...ascii('GPS-45.0N-009.0E')
])
const SCAN = [0xff, 0xda, 0, 4, 1, 2, 0x12, 0xff, 0x00, 0x34, 0xff, 0xe1, 0xff, 0xd9]
const jpeg = (...segments: number[][]) => bytesOf([0xff, 0xd8], ...segments, SCAN)

describe('a JPEG', () => {
  const KEPT = [segment(0xe0, ascii('JFIF\0\x01\x01')), segment(0xdb, [0, 1, 2, 3]), segment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0])]

  it('loses its Exif, its XMP, its IPTC and its comments, and keeps every other segment and the scan byte for byte', async () => {
    const original = jpeg(KEPT[0]!, exif(1), segment(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/\0'), ...ascii('<x:xmpmeta>Jane</x:xmpmeta>')]), segment(0xed, ascii('Photoshop 3.0')), segment(0xfe, ascii('shot at home')), KEPT[1]!, KEPT[2]!)
    const { out, bytes } = await stripped(original, 'p.jpg', 'image/jpeg')
    expect(out).not.toBe(undefined)
    expect(bytes).toEqual(jpeg(...KEPT))
    for (const secret of ['GPS', 'Jane', 'Photoshop', 'home']) expect(textOf(bytes)).not.toContain(secret)
  })

  it('keeps a photo\'s rotation as the one small tag it needs, and nothing else of the Exif', async () => {
    const { bytes } = await stripped(jpeg(...KEPT, exif(6)), 'p.jpg')
    expect(textOf(bytes)).not.toContain('GPS')
    const start = bytes.indexOf(0xe1) - 1
    expect([bytes[start], bytes[start + 1]]).toEqual([0xff, 0xe1])
    expect(bytes.subarray(start + 20, start + 28)).toEqual(Uint8Array.from([0x12, 0x01, 3, 0, 1, 0, 0, 0]))
    expect(bytes[start + 28]).toBe(6)
    expect(bytes.length).toBe(jpeg(...KEPT).length + 36)
  })

  it('reads the rotation of a little-endian Exif block too', async () => {
    const little = segment(0xe1, [...ascii('Exif'), 0, 0, 0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0])
    const { bytes } = await stripped(jpeg(...KEPT, little), 'p.jpg')
    expect(bytes[bytes.indexOf(0xe1) - 1 + 28]).toBe(8)
  })

  it('goes up as it was when there is nothing to remove', async () => {
    const { file, out } = await stripped(jpeg(...KEPT), 'p.jpg')
    expect(out).toBe(file)
  })

  it.each([
    ['cut inside a segment', (bytes: Uint8Array) => bytes.subarray(0, 12)],
    ['a segment that claims more than the file holds', (bytes: Uint8Array) => { const copy = bytes.slice(); copy[5] = 0xff; return copy }],
    ['a stray byte where a marker belongs', (bytes: Uint8Array) => { const copy = bytes.slice(); copy[13] = 0x12; return copy }]
  ])('goes up as it was when it is %s', async (_name, damage) => {
    const { file, out } = await stripped(damage(jpeg(...KEPT, exif(1))), 'p.jpg')
    expect(out).toBe(file)
  })
})

// --- PNG
const crc = [0, 0, 0, 0]
const chunk = (type: string, data: number[]) => [...be32(data.length), ...ascii(type), ...data, ...crc]
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const png = (...chunks: number[][]) => bytesOf(PNG_SIGNATURE, ...chunks, chunk('IEND', []))

describe('a PNG', () => {
  const HEADER = chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])
  const DRAWING = [chunk('gAMA', [0, 1, 0, 0]), chunk('pHYs', [0, 0, 0xe, 0xc3, 0, 0, 0xe, 0xc3, 1]), chunk('IDAT', [1, 2, 3, 4, 5])]

  it('loses its text, time and Exif chunks and keeps the critical chunks and the ones that draw it', async () => {
    const { bytes } = await stripped(png(HEADER, chunk('tEXt', ascii('Author\0Jane')), DRAWING[0]!, chunk('tIME', [7, 232, 1, 1, 0, 0, 0]), chunk('eXIf', ascii('GPS')), DRAWING[1]!, chunk('iTXt', ascii('x')), DRAWING[2]!), 'p.png', 'image/png')
    expect(bytes).toEqual(png(HEADER, ...DRAWING))
    expect(textOf(bytes)).not.toContain('Jane')
  })

  it('keeps what trails the end chunk, and goes up as it was when there is nothing to remove', async () => {
    const trailer = bytesOf(Array.from(png(HEADER, chunk('tEXt', ascii('a\0b')), ...DRAWING)), ascii('tail'))
    const { bytes } = await stripped(trailer, 'p.png')
    expect(bytes).toEqual(bytesOf(Array.from(png(HEADER, ...DRAWING)), ascii('tail')))
    const plain = await stripped(png(HEADER, ...DRAWING), 'p.png')
    expect(plain.out).toBe(plain.file)
  })

  it('goes up as it was when it ends before its end chunk', async () => {
    const whole = png(HEADER, chunk('tEXt', ascii('a\0b')), ...DRAWING)
    const { file, out } = await stripped(whole.subarray(0, whole.length - 12), 'p.png')
    expect(out).toBe(file)
  })
})

// --- WebP
const riffChunk = (type: string, data: number[]) => [...ascii(type), ...le32(data.length), ...data, ...(data.length % 2 === 1 ? [0] : [])]
const webp = (...chunks: number[][]) => { const body = [...ascii('WEBP'), ...chunks.flat()]; return bytesOf(ascii('RIFF'), le32(body.length), body) }

describe('a WebP', () => {
  const FLAGS_AT = 20
  const VP8X = (flags: number) => riffChunk('VP8X', [flags, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  const PIXELS = riffChunk('VP8 ', [1, 2, 3, 4, 5])

  it('loses its Exif and XMP chunks, clears the two flags that announce them, and keeps the size of the file right', async () => {
    const { bytes } = await stripped(webp(VP8X(0x2c), PIXELS, riffChunk('EXIF', ascii('GPS')), riffChunk('XMP ', ascii('Jane'))), 'p.webp', 'image/webp')
    expect(bytes).toEqual(webp(VP8X(0x20), PIXELS))
    expect(bytes[FLAGS_AT]).toBe(0x20)
    expect(new DataView(bytes.buffer).getUint32(4, true)).toBe(bytes.length - 8)
  })

  it('clears the flags even when no such chunk is left to remove, and keeps what trails the file', async () => {
    const { bytes } = await stripped(bytesOf(Array.from(webp(VP8X(0x0c), PIXELS)), ascii('tail')), 'p.webp')
    expect(bytes[FLAGS_AT]).toBe(0)
    expect(textOf(bytes).endsWith('tail')).toBe(true)
  })

  it('goes up as it was when it has no metadata or the sizes do not add up', async () => {
    const plain = await stripped(webp(VP8X(0x20), PIXELS), 'p.webp')
    expect(plain.out).toBe(plain.file)
    const cut = webp(PIXELS, riffChunk('EXIF', ascii('GPS')))
    const damaged = await stripped(cut.subarray(0, cut.length - 6), 'p.webp')
    expect(damaged.out).toBe(damaged.file)
  })
})

describe('anything else', () => {
  it('is never changed: a GIF, a video, text, an empty file, and a file named like an image', async () => {
    for (const content of [bytesOf(ascii('GIF89a'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), bytesOf(ascii('....ftypmp42'), ascii('GPS')), bytesOf(ascii('hello')), new Uint8Array(0), bytesOf(ascii('GPS not a jpeg'))]) {
      const { file, out } = await stripped(content, 'p.jpg', 'image/jpeg')
      expect(out).toBe(file)
    }
  })

  it('names the result as the file was named, with its type and time', async () => {
    const file = new File([jpeg(segment(0xfe, ascii('x')))], 'holiday.jpg', { type: 'image/jpeg', lastModified: 1234 })
    const out = await stripMetadata(file)
    expect([out.name, out.type, out.lastModified]).toEqual(['holiday.jpg', 'image/jpeg', 1234])
    expect(out).not.toBe(file)
  })
})

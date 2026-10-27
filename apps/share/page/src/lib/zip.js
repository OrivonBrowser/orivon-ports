// Store-only ZIP, written and read here. The writer produces what `unzip` and Python's zipfile read: local headers
// that carry sizes and CRC-32, UTF-8 names, a central directory, no compression, no ZIP64, no data descriptors. The
// reader accepts that and nothing else, and checks every CRC. Files are Blobs the whole way: the archive is a Blob
// of headers and the picked files themselves, and a file is read once, to checksum it.

export class ZipError extends Error {
  /** @param {string} message */
  constructor (message) {
    super(message)
    this.name = 'ZipError'
  }
}

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const END_SIGNATURE = 0x06054b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const VERSION = 20
const FLAG_UTF8 = 0x0800
/** 1980-01-01 00:00, so that an archive of the same files is the same bytes and says nothing of when files changed. */
const DOS_TIME = 0
const DOS_DATE = 0x0021
const LOCAL_HEADER = 30
const CENTRAL_HEADER = 46
const END_RECORD = 22
const MAX_ENTRIES = 65534
const MAX_ARCHIVE = 0xfffffffe
const MAX_NAME_BYTES = 1024
const MAX_CENTRAL_BYTES = 64 * 1024 * 1024
const ZIP64_EXTRA = 0x0001

const encoder = new TextEncoder()
const utf8 = new TextDecoder('utf-8', { fatal: true })

const TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** CRC-32 over bytes arriving in pieces. */
export class Crc32 {
  constructor () {
    this.state = -1
  }

  /** @param {Uint8Array} bytes */
  update (bytes) {
    let c = this.state
    for (let i = 0; i < bytes.length; i++) c = /** @type {number} */ (TABLE[(c ^ /** @type {number} */ (bytes[i])) & 255]) ^ (c >>> 8)
    this.state = c
    return this
  }

  get value () {
    return (this.state ^ -1) >>> 0
  }
}

/** @param {Uint8Array} bytes */
export function crc32 (bytes) {
  return new Crc32().update(bytes).value
}

/**
 * The CRC-32 of a Blob, read in pieces.
 * @param {Blob} blob
 * @param {{ signal?: AbortSignal, onBytes?: (bytes: number) => void }} [options]
 */
export async function blobCrc32 (blob, { signal, onBytes } = {}) {
  const crc = new Crc32()
  const reader = blob.stream().getReader()
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      crc.update(value)
      onBytes?.(value.length)
    }
  } finally {
    reader.releaseLock()
  }
  return crc.value
}

/**
 * Throws unless `name` is a relative path of plain segments: no `..`, no empty segment, no backslash, no NUL or
 * other control character, no leading or trailing slash.
 * @param {string} name
 */
export function checkZipName (name) {
  const shown = JSON.stringify(name.slice(0, 80))
  if (name === '') throw new ZipError('The archive has a file with no name.')
  if (encoder.encode(name).length > MAX_NAME_BYTES) throw new ZipError(`The archive has a file name that is too long: ${shown}`)
  if (name.includes('\\')) throw new ZipError(`The archive has a file name with a backslash: ${shown}`)
  if (name.startsWith('/')) throw new ZipError(`The archive has an absolute file name: ${shown}`)
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new ZipError(`The archive has a file name with a control character: ${shown}`)
  if (name.endsWith('/')) throw new ZipError(`The archive has a folder entry: ${shown}`)
  for (const segment of name.split('/')) {
    if (segment === '') throw new ZipError(`The archive has an empty part in a file name: ${shown}`)
    if (segment === '.' || segment === '..') throw new ZipError(`The archive has a file name that leaves its folder: ${shown}`)
  }
}

/** @param {number} size @param {(view: DataView) => void} fill */
function record (size, fill) {
  const bytes = new Uint8Array(size)
  fill(new DataView(bytes.buffer))
  return bytes
}

/**
 * The archive of `files`, in order, as a Blob.
 * @param {{ name: string, file: Blob }[]} files
 * @param {{ signal?: AbortSignal, onBytes?: (bytes: number) => void }} [options]
 * @returns {Promise<Blob>}
 */
export async function writeZip (files, { signal, onBytes } = {}) {
  if (files.length > MAX_ENTRIES) throw new ZipError(`An archive holds ${MAX_ENTRIES} files at most.`)
  /** @type {BlobPart[]} */
  const parts = []
  /** @type {Uint8Array[]} */
  const central = []
  const seen = new Set()
  let offset = 0
  for (const { name, file } of files) {
    checkZipName(name)
    if (seen.has(name)) throw new ZipError(`The archive would hold ${JSON.stringify(name)} twice.`)
    seen.add(name)
    const nameBytes = encoder.encode(name)
    const crc = await blobCrc32(file, { ...(signal ? { signal } : {}), ...(onBytes ? { onBytes } : {}) })
    const size = file.size
    const local = record(LOCAL_HEADER + nameBytes.length, (v) => {
      v.setUint32(0, LOCAL_SIGNATURE, true)
      v.setUint16(4, VERSION, true)
      v.setUint16(6, FLAG_UTF8, true)
      v.setUint16(8, 0, true)
      v.setUint16(10, DOS_TIME, true)
      v.setUint16(12, DOS_DATE, true)
      v.setUint32(14, crc, true)
      v.setUint32(18, size, true)
      v.setUint32(22, size, true)
      v.setUint16(26, nameBytes.length, true)
      v.setUint16(28, 0, true)
    })
    local.set(nameBytes, LOCAL_HEADER)
    central.push(record(CENTRAL_HEADER + nameBytes.length, (v) => {
      v.setUint32(0, CENTRAL_SIGNATURE, true)
      v.setUint16(4, VERSION, true)
      v.setUint16(6, VERSION, true)
      v.setUint16(8, FLAG_UTF8, true)
      v.setUint16(10, 0, true)
      v.setUint16(12, DOS_TIME, true)
      v.setUint16(14, DOS_DATE, true)
      v.setUint32(16, crc, true)
      v.setUint32(20, size, true)
      v.setUint32(24, size, true)
      v.setUint16(28, nameBytes.length, true)
      v.setUint32(42, offset, true)
    }))
    central[central.length - 1]?.set(nameBytes, CENTRAL_HEADER)
    parts.push(/** @type {BlobPart} */ (local), file)
    offset += local.length + size
    if (offset > MAX_ARCHIVE) throw new ZipError('The files together are too large for one ZIP archive.')
  }
  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0)
  parts.push(...central.map((entry) => /** @type {BlobPart} */ (entry)))
  parts.push(/** @type {BlobPart} */ (record(END_RECORD, (v) => {
    v.setUint32(0, END_SIGNATURE, true)
    v.setUint16(8, files.length, true)
    v.setUint16(10, files.length, true)
    v.setUint32(12, centralSize, true)
    v.setUint32(16, offset, true)
  })))
  return new Blob(parts, { type: 'application/zip' })
}

/** @param {Blob} blob @param {number} start @param {number} end */
async function bytesOf (blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer())
}

/** @param {Uint8Array} bytes @param {boolean} utf8Flag */
function nameOf (bytes, utf8Flag) {
  if (utf8Flag) {
    try {
      return utf8.decode(bytes)
    } catch {
      throw new ZipError('The archive has a file name that is not valid UTF-8.')
    }
  }
  for (const byte of bytes) if (byte < 0x20 || byte > 0x7e) throw new ZipError('The archive has a file name in an encoding Share does not read.')
  return String.fromCharCode(...bytes)
}

/** Whether an extra field holds a ZIP64 record. @param {Uint8Array} extra */
function hasZip64Extra (extra) {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength)
  for (let at = 0; at + 4 <= extra.length;) {
    if (view.getUint16(at, true) === ZIP64_EXTRA) return true
    at += 4 + view.getUint16(at + 2, true)
  }
  return false
}

/**
 * @typedef {{ name: string, flags: number, crc: number, size: number, offset: number }} CentralEntry
 */

/** @param {Blob} blob @returns {Promise<{ entries: CentralEntry[], centralStart: number }>} */
async function readCentral (blob) {
  if (blob.size < END_RECORD) throw new ZipError('This is not a ZIP archive.')
  const end = new DataView((await bytesOf(blob, blob.size - END_RECORD, blob.size)).buffer)
  if (end.getUint32(0, true) !== END_SIGNATURE) throw new ZipError('This is not a ZIP archive Share can read: it has a comment or data after its end.')
  const entryCount = end.getUint16(10, true)
  const centralSize = end.getUint32(12, true)
  const centralStart = end.getUint32(16, true)
  if (end.getUint16(4, true) !== 0 || end.getUint16(6, true) !== 0 || end.getUint16(8, true) !== entryCount || end.getUint16(20, true) !== 0) {
    throw new ZipError('This ZIP archive is split over several parts, which Share does not read.')
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralStart === 0xffffffff) throw new ZipError('This ZIP archive uses ZIP64, which Share does not read.')
  if (blob.size >= END_RECORD + 20) {
    const locator = new DataView((await bytesOf(blob, blob.size - END_RECORD - 20, blob.size - END_RECORD)).buffer)
    if (locator.getUint32(0, true) === ZIP64_LOCATOR_SIGNATURE) throw new ZipError('This ZIP archive uses ZIP64, which Share does not read.')
  }
  if (centralSize > MAX_CENTRAL_BYTES || centralStart + centralSize !== blob.size - END_RECORD) throw new ZipError('This ZIP archive is damaged: its directory is not where it says.')
  const bytes = await bytesOf(blob, centralStart, centralStart + centralSize)
  const view = new DataView(bytes.buffer)
  /** @type {CentralEntry[]} */
  const entries = []
  let at = 0
  for (let i = 0; i < entryCount; i++) {
    if (at + CENTRAL_HEADER > bytes.length || view.getUint32(at, true) !== CENTRAL_SIGNATURE) throw new ZipError('This ZIP archive is damaged: its directory is cut short.')
    const needed = view.getUint16(at + 6, true)
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const crc = view.getUint32(at + 16, true)
    const packed = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const disk = view.getUint16(at + 34, true)
    const offset = view.getUint32(at + 42, true)
    const next = at + CENTRAL_HEADER + nameLength + extraLength + commentLength
    if (next > bytes.length) throw new ZipError('This ZIP archive is damaged: its directory is cut short.')
    if (packed === 0xffffffff || size === 0xffffffff || offset === 0xffffffff || needed > VERSION || hasZip64Extra(bytes.subarray(at + CENTRAL_HEADER + nameLength, at + CENTRAL_HEADER + nameLength + extraLength))) {
      throw new ZipError('This ZIP archive uses ZIP64, which Share does not read.')
    }
    if ((flags & ~FLAG_UTF8) !== 0) throw new ZipError('This ZIP archive is encrypted or uses features Share does not read.')
    if (method !== 0 || packed !== size) throw new ZipError('This ZIP archive is compressed, and Share reads only the archives it makes, which are not.')
    if (disk !== 0) throw new ZipError('This ZIP archive is split over several parts, which Share does not read.')
    const name = nameOf(bytes.subarray(at + CENTRAL_HEADER, at + CENTRAL_HEADER + nameLength), (flags & FLAG_UTF8) !== 0)
    checkZipName(name)
    entries.push({ name, flags, crc, size, offset })
    at = next
  }
  if (at !== bytes.length) throw new ZipError('This ZIP archive is damaged: its directory has more in it than it counts.')
  return { entries, centralStart }
}

/**
 * Every file in a store-only archive, each checked: names, the layout the writer makes (entries one after the
 * other with nothing between), and the CRC-32 of each file's bytes.
 * @param {Blob} blob
 * @param {{ maxBytes?: number, maxEntries?: number, signal?: AbortSignal, onBytes?: (bytes: number) => void }} [options]
 * @returns {Promise<{ path: string, size: number, file: Blob }[]>}
 */
export async function readZip (blob, { maxBytes = MAX_ARCHIVE, maxEntries = MAX_ENTRIES, signal, onBytes } = {}) {
  const { entries, centralStart } = await readCentral(blob)
  if (entries.length > maxEntries) throw new ZipError(`This archive holds more than ${maxEntries} files.`)
  const names = new Set()
  let total = 0
  for (const entry of entries) {
    if (names.has(entry.name)) throw new ZipError(`The archive holds ${JSON.stringify(entry.name)} twice.`)
    names.add(entry.name)
    total += entry.size
  }
  if (total > maxBytes) throw new ZipError('The files in this archive are larger than Share opens.')
  /** @type {{ path: string, size: number, file: Blob }[]} */
  const files = []
  let expected = 0
  for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
    signal?.throwIfAborted()
    if (entry.offset !== expected) throw new ZipError('This ZIP archive is damaged: its files are not laid out one after the other.')
    const head = await bytesOf(blob, entry.offset, entry.offset + LOCAL_HEADER)
    const view = new DataView(head.buffer)
    if (head.length < LOCAL_HEADER || view.getUint32(0, true) !== LOCAL_SIGNATURE) throw new ZipError('This ZIP archive is damaged: a file header is missing.')
    const nameLength = view.getUint16(26, true)
    const extraLength = view.getUint16(28, true)
    const sameRecord = view.getUint16(6, true) === entry.flags && view.getUint16(8, true) === 0 &&
      view.getUint32(14, true) === entry.crc && view.getUint32(18, true) === entry.size && view.getUint32(22, true) === entry.size
    const local = await bytesOf(blob, entry.offset + LOCAL_HEADER, entry.offset + LOCAL_HEADER + nameLength + extraLength)
    if (!sameRecord || local.length !== nameLength + extraLength || nameOf(local.subarray(0, nameLength), (entry.flags & FLAG_UTF8) !== 0) !== entry.name) {
      throw new ZipError('This ZIP archive is damaged: a file header does not match its directory.')
    }
    const start = entry.offset + LOCAL_HEADER + nameLength + extraLength
    const file = blob.slice(start, start + entry.size)
    if (file.size !== entry.size || start + entry.size > centralStart) throw new ZipError('This ZIP archive is damaged: a file runs past its end.')
    const crc = await blobCrc32(file, { ...(signal ? { signal } : {}), ...(onBytes ? { onBytes } : {}) })
    if (crc !== entry.crc) throw new ZipError(`This ZIP archive is damaged: ${JSON.stringify(entry.name)} does not match its checksum.`)
    files.push({ path: entry.name, size: entry.size, file })
    expected = start + entry.size
  }
  if (expected !== centralStart) throw new ZipError('This ZIP archive is damaged: there is data between its files and its directory.')
  const order = new Map(entries.map((entry, index) => [entry.name, index]))
  return files.sort((a, b) => /** @type {number} */ (order.get(a.path)) - /** @type {number} */ (order.get(b.path)))
}

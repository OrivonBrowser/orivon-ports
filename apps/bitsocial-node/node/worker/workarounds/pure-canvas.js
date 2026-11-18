// Workaround, deletable when the Worker has a canvas it can load: the part of skia-canvas that captcha-canvas calls (`Canvas`,
// its 2D context, `toBuffer` and `toBufferSync` to a PNG, `loadImage`), drawn with pureimage, which is JavaScript. skia-canvas is
// a native module, and captcha-canvas imports it by that name; the build resolves the name here (build/challenges.mjs), so
// neither captcha-canvas nor the captcha challenge is changed. Text is drawn in the one font canvas-font.js holds, whatever
// family the code names, because pureimage draws a family it does not have in the first font it was given.

import opentype from 'opentype.js'
import { decode as decodeJpeg } from 'jpeg-js'
import { PNG } from 'pngjs'
import * as PImage from 'pureimage'
import { fontBytes } from './canvas-font.js'

let fontReady = false

/** Registers the bundled font once, from its bytes: pureimage's own loader reads a path, which the Worker cannot offer. */
function ensureFont () {
  if (fontReady) return
  const bytes = fontBytes()
  const registered = PImage.registerFont('(bundled)', 'Sans')
  registered.font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  registered.loaded = true
  fontReady = true
}

/** @param {{ width: number, height: number, data: Uint8Array }} bitmap @returns {Buffer} */
function encodePng (bitmap) {
  const png = new PNG({ width: bitmap.width, height: bitmap.height })
  png.data = Buffer.from(bitmap.data.buffer, bitmap.data.byteOffset, bitmap.data.byteLength)
  return PNG.sync.write(png)
}

export class Canvas {
  /** @param {number} [width] @param {number} [height] */
  constructor (width = 300, height = 150) {
    ensureFont()
    this.bitmap = PImage.make(width, height)
    /** skia-canvas draws on the GPU when it can; this never does. */
    this.gpu = false
    /** @type {import('pureimage').Context | null} */
    this.context = null
  }

  get width () { return this.bitmap.width }
  get height () { return this.bitmap.height }

  /** @param {string} type */
  getContext (type) {
    if (type !== '2d') return null
    this.context ??= this.bitmap.getContext('2d')
    return this.context
  }

  /** @param {string} [format] */
  toBufferSync (format = 'png') {
    if (format !== 'png') throw new Error(`this canvas writes png, not ${format}`)
    return encodePng(this.bitmap)
  }

  /** @param {string} [format] */
  async toBuffer (format = 'png') { return this.toBufferSync(format) }
}

/**
 * An image from its bytes (PNG or JPEG), as a bitmap `drawImage` takes. A path or a URL is not read: the Worker's callers hand over bytes.
 * @param {Uint8Array | Buffer | string} source
 */
export async function loadImage (source) {
  if (typeof source === 'string') throw new Error('loadImage takes the image bytes in this build, not a path or a URL')
  const bytes = Buffer.from(source)
  const isPng = bytes.length > 8 && bytes.subarray(1, 4).toString('latin1') === 'PNG'
  const decoded = isPng ? PNG.sync.read(bytes) : decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true })
  const bitmap = PImage.make(decoded.width, decoded.height)
  bitmap.data.set(decoded.data)
  return bitmap
}

/** skia-canvas's font registry; the one font is always there, and a family cannot be added. */
export const FontLibrary = {
  families: ['Sans'],
  has: (/** @type {string} */ _family) => true,
  use: () => { throw new Error('this build draws in one font and cannot load another') }
}

// The one typeface the captcha is drawn in. skia-canvas finds 'Sans' on the computer's own fonts, which the Worker does not have,
// so pure-canvas.js draws every family in this one. Plain Node reads the file from the dev dependency that holds it; the build
// replaces this module with one that holds the same bytes (build/challenges.mjs), because the Worker has no node_modules.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/** The font file's bytes (DejaVu Sans, under the DejaVu fonts licence: `UPSTREAM.md` names it). @returns {Uint8Array} */
export function fontBytes () {
  return readFileSync(createRequire(import.meta.url).resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'))
}

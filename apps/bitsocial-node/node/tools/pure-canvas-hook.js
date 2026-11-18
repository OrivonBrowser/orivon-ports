// Plain Node's copy of the build's one alias for the challenge packages: `skia-canvas`, the native canvas the captcha package
// imports, resolves to the pure-JavaScript canvas the Worker's bundle uses (`build/challenges.mjs`). It has to be registered
// before the challenge packages are imported, so a tool that runs `worker/run.js` imports that file after calling this.
// With `CAPTCHA_TAP` set (a file) the captcha library is read through `captcha-tap.js`, which writes each answer there, so a
// run that plays the author can answer a captcha it cannot read; nothing else about the library changes.

import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const fileUrl = (/** @type {string} */ relative) => pathToFileURL(fileURLToPath(new URL(relative, import.meta.url))).href
const PURE_CANVAS = fileUrl('../worker/workarounds/pure-canvas.js')
const CAPTCHA_TAP = fileUrl('./captcha-tap.js')

/** Resolves `skia-canvas` to the pure-JavaScript canvas for every import after this call. */
export function aliasSkiaCanvas () {
  const tapped = (process.env['CAPTCHA_TAP'] ?? '') !== ''
  if (tapped) process.env['CAPTCHA_REAL'] = createRequire(import.meta.url).resolve('captcha-canvas')
  return registerHooks({
    resolve (specifier, context, nextResolve) {
      if (specifier === 'skia-canvas') return { url: PURE_CANVAS, format: 'module', shortCircuit: true }
      if (tapped && specifier === 'captcha-canvas') return { url: CAPTCHA_TAP, format: 'module', shortCircuit: true }
      return nextResolve(specifier, context)
    }
  })
}

// The captcha library, with each answer it makes appended to the file `CAPTCHA_TAP` names (`pure-canvas-hook.js` puts this module
// in its place for a run that sets it). A test that plays the author reads the last line to answer a captcha it cannot see.

import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const real = createRequire(import.meta.url)(/** @type {string} */ (process.env['CAPTCHA_REAL']))
const file = /** @type {string} */ (process.env['CAPTCHA_TAP'])

/** @param {...any} args */
export function createCaptcha (...args) {
  const made = real.createCaptcha(...args)
  appendFileSync(file, `${String(made.text)}\n`)
  return made
}
export default real

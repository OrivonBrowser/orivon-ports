// Preloaded (`node --import`) when TiddlyWiki renders the editions. TiddlyWiki writes the core in the order it
// reads the files, and Node lists a directory in the order the system gives: sorted by bytes on Linux and macOS,
// without regard to case on Windows. Sorting here gives every host the order Linux has, so the core is the same
// bytes everywhere and the relay's known CID for it holds.

import fs from 'node:fs'

const readdirSync = fs.readdirSync

/** @param {unknown} entry */
const nameOf = (entry) => typeof entry === 'string' ? entry : /** @type {{ name: string }} */ (entry).name

fs.readdirSync = function sortedReaddirSync (...args) {
  const entries = readdirSync.apply(this, /** @type {any} */ (args))
  if (!Array.isArray(entries)) return entries
  return entries.sort((a, b) => {
    const [x, y] = [nameOf(a), nameOf(b)]
    return x < y ? -1 : x > y ? 1 : 0
  })
}

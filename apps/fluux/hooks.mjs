// One edit to the built index.html: the inline process.nextTick shim moves to a file.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const SHIM_FILE = 'orivon/next-tick-shim.js'

const INLINE_SHIM = /<script>(globalThis\.process=globalThis\.process\|\|\{\};process\.nextTick=[^<]*)<\/script>/

/**
 * Upstream's index.html carries one inline classic script that defines
 * `process.nextTick` for its SCRAM-SHA-1 dependencies. The app's CSP has no
 * 'unsafe-inline', so the script never runs and the first stream.nextTick call
 * throws. The script moves to `orivon/next-tick-shim.js` byte for byte and is
 * loaded in its place, before the module script that needs it.
 */
export async function transformHtml (html, { dirs }) {
  const match = html.match(INLINE_SHIM)
  if (match === null) {
    if (html.includes(SHIM_FILE)) return html
    throw new Error('fluux hooks: the built index.html has no inline process.nextTick script -- upstream changed how it shims SCRAM-SHA-1, so check whether the move is still needed')
  }
  const target = join(dirs.static, SHIM_FILE)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${match[1]}\n`)
  return html.replace(match[0], `<script src="${SHIM_FILE}"></script>`)
}

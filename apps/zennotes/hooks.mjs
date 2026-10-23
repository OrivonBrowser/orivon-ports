// One edit to the built index.html: the bundle first in the head, and the renderer's entry module
// started by a script of its own after the bundle's start-up work (see bridge/build-plan.js).
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { START_FILE, startHtml, startScript } from './bridge/build-plan.js'

export async function transformHtml (html, { dirs }) {
  const { html: rewritten, entry } = startHtml(html)
  if (entry === null) return rewritten
  const target = join(dirs.static, START_FILE)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, startScript(entry))
  return rewritten
}

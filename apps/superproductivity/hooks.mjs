// Two edits to the built index.html, both for a policy the Electron window does
// not have: the served page's script-src admits no inline script and no inline
// event handler.
//
// 1. upstream's three inline scripts (the launch screen that paints the app's frame
//    before any bundle runs, the browser check with the productivity tips the
//    splash screen shows, and the builder's one-liner that restores a deferred
//    stylesheet's media) move, byte for byte, to files in the served tree, each
//    loaded in the place it stood;
// 2. the critical-CSS pattern Angular's builder writes,
//    `<link rel="stylesheet" media="print" data-beasties-media="all">`, loses
//    the two attributes, so the stylesheet applies at once instead of waiting
//    for that one-liner, which the moved file then finds nothing to do for.
//
// Two more files are added beside them: the page the bridge sends a second tab of the
// app to (see ALREADY_OPEN_FILE), because the Electron app is single-instance by
// its main process and a browser tab is not; and the script a plugin's page runs its inline
// scripts with (see PLUGIN_FRAME_FILE), which is ours and is copied as it is.
//
// Nothing else of the built page is touched, and a document already rewritten is returned as it is.
// Once the tree is complete (prepare adds the icon link, the hint and the bridge to the same page),
// `finishTree` makes the service worker manifest agree with it: each hash is the file as served (the
// worker refuses an app version whose `index.html` hashes otherwise), and the files under `orivon/`,
// which the page loads and no upstream asset group names, are cached with the app.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refreshNgswHashes } from '../../src/build/ngsw-kit.mjs'

export const INLINE_SCRIPT_COUNT = 3
export const inlineScriptFile = (index) => `orivon/inline-script-${String(index + 1)}.js`
export const ALREADY_OPEN_FILE = 'orivon/already-open.html'
// Where the bridge's srcdoc rewrite points a plugin's page (PLUGIN_FRAME_RUNNER there).
export const PLUGIN_FRAME_FILE = 'orivon/plugin-frame.js'
const PLUGIN_FRAME_SOURCE = fileURLToPath(new URL('./bridge/plugin-frame.js', import.meta.url))

// Plain markup, no script and no inline style attribute beyond one <style>: the
// served policy admits no inline script, and this page must work with none.
const ALREADY_OPEN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Super Productivity is already open</title>
<style>
  body { margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; font: 16px/1.5 system-ui, sans-serif; background: #f8f8f6; color: #222; text-align: center; padding: 2rem; box-sizing: border-box; }
  @media (prefers-color-scheme: dark) { body { background: #121212; color: #eee; } }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { margin: 0; max-width: 32rem; }
</style>
</head>
<body>
<main>
<h1>Super Productivity is already open</h1>
<p>It is open in another tab of this browser. Two tabs would write to the same data, so this one stays closed. Close the other tab, then reload this one.</p>
</main>
</body>
</html>
`

const COMMENT = /<!--[\s\S]*?-->/g
const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/g
const PRINT_UNTIL_RESTORED = /(<link\b[^>]*\brel="stylesheet"[^>]*?)\s+media="print"\s+data-beasties-media="all"/g

/**
 * `html` with every HTML comment replaced by a placeholder, and the function
 * that puts them back: upstream's index.html explains its CSP in a comment that
 * itself contains the text `<script>`.
 */
function withoutComments (html) {
  const comments = []
  const masked = html.replace(COMMENT, (comment) => {
    comments.push(comment)
    return `<!--orivon-comment-${String(comments.length - 1)}-->`
  })
  return { masked, restore: (text) => text.replace(/<!--orivon-comment-(\d+)-->/g, (_all, index) => comments[Number(index)]) }
}

async function moveInlineScripts (masked, dirs) {
  const scripts = [...masked.matchAll(INLINE_SCRIPT)]
  if (scripts.length === 0) return masked
  if (scripts.length !== INLINE_SCRIPT_COUNT) {
    throw new Error(`superproductivity hooks: expected ${String(INLINE_SCRIPT_COUNT)} inline <script> elements in the built index.html, found ${String(scripts.length)} -- upstream's index.html changed shape`)
  }
  for (const [index, script] of scripts.entries()) {
    const target = join(dirs.static, inlineScriptFile(index))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, script[1])
  }
  let index = 0
  return masked.replace(INLINE_SCRIPT, () => `<script src="${inlineScriptFile(index++)}"></script>`)
}

async function writeAlreadyOpenPage (dirs) {
  const target = join(dirs.static, ALREADY_OPEN_FILE)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, ALREADY_OPEN_PAGE)
}

async function writePluginFrameRunner (dirs) {
  const target = join(dirs.static, PLUGIN_FRAME_FILE)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, await readFile(PLUGIN_FRAME_SOURCE))
}

export async function transformHtml (html, { dirs }) {
  await writeAlreadyOpenPage(dirs)
  await writePluginFrameRunner(dirs)
  const { masked, restore } = withoutComments(html)
  const moved = await moveInlineScripts(masked, dirs)
  const unblocked = moved.replace(PRINT_UNTIL_RESTORED, '$1')
  if (/\bdata-beasties-media=|\bonload="this\.media=/.test(unblocked)) {
    throw new Error("superproductivity hooks: a stylesheet still waits on a script or handler to apply -- upstream's critical-CSS markup changed shape")
  }
  return restore(unblocked)
}

export async function finishTree ({ dirs }) {
  await refreshNgswHashes(dirs.static, { cacheFolders: ['orivon'] })
}

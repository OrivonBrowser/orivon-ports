// Two edits to the built index.html, both for a policy the Electron window does
// not have: the served page's script-src admits no inline script and no inline
// event handler.
//
// 1. upstream's inline script (the browser check and the productivity tips the
//    splash screen shows) moves, byte for byte, to a file in the served tree;
// 2. the critical-CSS pattern Angular's builder writes,
//    `<link rel="stylesheet" media="print" onload="this.media='all'">`, loses
//    the two attributes, so the stylesheet applies at once instead of staying
//    print-only because its onload handler never runs.
//
// A third file is added beside them: the page the bridge sends a second tab of the
// app to (see ALREADY_OPEN_FILE), because the Electron app is single-instance by
// its main process and a browser tab is not.
//
// Nothing else is touched, and a document already rewritten is returned as it is.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const INLINE_SCRIPT_FILE = 'orivon/splash-script.js'
export const ALREADY_OPEN_FILE = 'orivon/already-open.html'

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
const PRINT_ONLOAD = /(<link\b[^>]*\brel="stylesheet"[^>]*?)\s+media="print"\s+onload="this\.media='all'"/g

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

async function moveInlineScript (masked, dirs) {
  const scripts = [...masked.matchAll(INLINE_SCRIPT)]
  if (scripts.length === 0) return masked
  if (scripts.length !== 1) {
    throw new Error(`superproductivity hooks: expected one inline <script> in the built index.html, found ${String(scripts.length)} -- upstream's index.html changed shape`)
  }
  const target = join(dirs.static, INLINE_SCRIPT_FILE)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, scripts[0][1])
  return masked.replace(INLINE_SCRIPT, `<script src="${INLINE_SCRIPT_FILE}"></script>`)
}

async function writeAlreadyOpenPage (dirs) {
  const target = join(dirs.static, ALREADY_OPEN_FILE)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, ALREADY_OPEN_PAGE)
}

export async function transformHtml (html, { dirs }) {
  await writeAlreadyOpenPage(dirs)
  const { masked, restore } = withoutComments(html)
  const moved = await moveInlineScript(masked, dirs)
  const unblocked = moved.replace(PRINT_ONLOAD, '$1')
  if (unblocked === moved && /\bonload="this\.media='all'"/.test(moved)) {
    throw new Error("superproductivity hooks: a stylesheet still waits on an onload handler -- upstream's critical-CSS markup changed shape")
  }
  return restore(unblocked)
}

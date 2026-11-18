// Edits to the built index.html, for a policy the Electron window does not have (the served page's script-src admits
// no inline script) and for the node this build runs:
//
// 1. The six executable inline scripts of upstream's index.html (the stats prefetch, the translation and route
//    preloads, the theme class, the static-shell paint, and the `/#` redirect) move to files in the served tree, each
//    loaded where it stood. Five move byte for byte. The redirect is written again, because it sends a deep link such
//    as /b/catalog to `/#/b/catalog` from the root of the host, which on a path gateway (/ipfs/<cid>/) leaves the
//    app. The file takes the app's root from where it is itself loaded. The JSON data blocks are not executable.
// 2. The module entry is typed `orivon-held-module`, so no browser runs it until orivon/node-start.js, which starts
//    the node, gives it its type back once the page is parsed.
// 3. Five scripts of the port's own are added to the head, in the order they load: the three that drive image hosts,
//    get a Turnstile token and show third-party embeds (bridge/webview-*.js), node-client.js from the node bundle, and
//    node-start.js.
//
// Beside them, the node dashboard the app's "node" link opens: this app's frame (its wording and its look, from the app's own built
// stylesheet) and the script that mounts the node app's dashboard module in it, which draws what the node says.
//
// A document already rewritten is returned as it is.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const INLINE_SCRIPT_COUNT = 6
export const inlineScriptFile = (index) => `orivon/inline-script-${String(index + 1)}.js`
export const NODE_DASHBOARD_FILE = 'orivon/node/index.html'
export const NODE_DASHBOARD_SCRIPT = 'orivon/node/dashboard.js'
export const HELPER_SCRIPTS = ['webview-upload.js', 'webview-turnstile.js', 'webview-embeds.js', 'node-start.js']
export const helperScriptFile = (name) => `orivon/${name}`
/** The node's page module, which the build puts at the root of the tree from the node bundle. */
export const NODE_CLIENT_FILE = 'node-client.js'
/** The node's dashboard module, which the build puts at the root of the tree beside it: it draws what the app's own `dashboard.js` mounts. */
export const NODE_DASHBOARD_MODULE = 'node-dashboard.js'
/** The type a module entry carries until the node answers: a browser runs no script of a type it does not know. */
export const HELD_TYPE = 'orivon-held-module'
/** The scripts added to the head, in the order they load: node-start.js reads what node-client.js sets. */
export const HEAD_SCRIPTS = [helperScriptFile('webview-upload.js'), helperScriptFile('webview-turnstile.js'), helperScriptFile('webview-embeds.js'), NODE_CLIENT_FILE, helperScriptFile('node-start.js')]

const COMMENT = /<!--[\s\S]*?-->/g
const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/g
const REDIRECT_MARK = "window.location.replace('/#'"
const STYLESHEET = /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="\.\/(assets\/src-[^"]+\.css)"/
const MODULE_ENTRY = /<script type="module"((?: crossorigin)? src="\.\/assets\/index-[^"]+\.js")><\/script>/g

// The root is the folder above orivon/, read from this file's own address.
const REDIRECT_SCRIPT = `(function () {
  var root = new URL('../', document.currentScript.src).pathname;
  var path = window.location.pathname;
  if (
    window.location.protocol !== 'file:' &&
    path.indexOf(root) === 0 &&
    path !== root &&
    !path.endsWith('/index.html') &&
    !window.location.hash
  ) {
    window.location.replace(root + '#/' + path.slice(root.length) + window.location.search);
  }
})();
`

/** Upstream's HTML explains itself in comments that can contain the text `<script>`, so they are set aside first. */
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
  const redirects = scripts.filter((script) => script[1].includes(REDIRECT_MARK))
  if (scripts.length !== INLINE_SCRIPT_COUNT || redirects.length !== 1) {
    throw new Error(`5chan hooks: expected ${String(INLINE_SCRIPT_COUNT)} inline <script> elements with one /# redirect in the built index.html, found ${String(scripts.length)} with ${String(redirects.length)} -- upstream's index.html changed shape`)
  }
  for (const [index, script] of scripts.entries()) {
    const target = join(dirs.static, inlineScriptFile(index))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, script[1].includes(REDIRECT_MARK) ? REDIRECT_SCRIPT : script[1])
  }
  let index = 0
  return masked.replace(INLINE_SCRIPT, () => `<script src="${inlineScriptFile(index++)}"></script>`)
}

function dashboardPage (stylesheet) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Node dashboard</title>
<link rel="stylesheet" href="../../${stylesheet}">
<style>
  :root { color-scheme: light; }
  [hidden] { display: none !important; }
  main { max-width: 46rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { margin: 0 0 .75rem; line-height: 1.5; }
  dd { margin: 0; overflow-wrap: anywhere; }
  a { color: var(--post-link-text-color, #00e); }
  .nd-status { font-size: 1.1rem; margin: 1rem 0 .25rem; }
  .nd-stats, .nd-facts { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1.5rem; margin: 0 0 1rem; }
  .nd-section-title { margin: 1.25rem 0 .5rem; padding: 2px 6px; font-size: 11pt; font-weight: 700; color: var(--homepage-box-bar-text-color, #800); background: var(--homepage-box-bar-background-color, #fca); border: 1px solid var(--homepage-box-border-color, #800); }
  .nd-note { color: var(--post-mobile-abbr-text-color, #707070); }
  .nd-error, .nd-field-error, .nd-form-message[data-nd-failed="true"] { color: var(--mod-queue-alert-color, #d00); font-weight: 700; }
  .nd-board { margin: 0 0 .75rem; padding: .5rem; background: var(--homepage-box-background-color, #fff); border: 1px solid var(--homepage-box-border-color, #800); }
  .nd-board-head { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin: 0 0 .5rem; }
  .nd-address { flex: 1 1 14rem; margin: 0; font-size: 11pt; font-weight: 700; color: var(--post-subject-text-color, #cc1105); overflow-wrap: anywhere; }
  .nd-badge { padding: 0 6px; font-size: 10pt; border: 1px solid var(--post-form-field-input-border-color, #aaa); color: var(--post-mobile-abbr-text-color, #707070); }
  .nd-badge[data-nd-state="running"] { color: var(--post-name-text-color, #117743); border-color: var(--post-name-text-color, #117743); }
  .nd-badge[data-nd-state="backoff"] { color: var(--mod-queue-alert-color, #d00); border-color: var(--mod-queue-alert-color, #d00); }
  .nd-form { margin: 0; }
  .nd-field { margin: 0 0 .5rem; }
  .nd-label { display: block; padding: 0 5px; font-size: var(--post-form-field-title-font-size, 10pt); font-weight: 700; color: var(--post-form-field-title-color, #800); background: var(--post-form-field-title-background-color, #ea8); border: var(--post-form-field-border, 1px solid #800); }
  .nd-control { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .5rem; padding: .25rem 0 0; }
  .nd-input { width: 7rem; padding: 1px 3px; font: inherit; color: var(--post-form-field-input-color, #000); background-color: var(--post-form-field-input-background-color, #fff); border: var(--post-form-field-input-border, 1px solid #aaa); }
  select.nd-input { width: auto; max-width: 100%; }
  .nd-input:focus { outline: none; border: var(--post-form-field-input-focus-border, 1px solid #ea8); }
  .nd-hint { font-size: 10pt; color: var(--post-mobile-abbr-text-color, #707070); overflow-wrap: anywhere; }
  .nd-field-error { display: block; font-size: 10pt; }
  .nd-actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
  .nd-form-message { margin: .25rem 0 0; min-height: 1.2em; }
  .nd-button { font: inherit; padding: 1px 8px; cursor: pointer; }
  .nd-challenge { margin: 0 0 .5rem; padding: .5rem; border: 1px solid var(--post-form-field-input-border-color, #aaa); }
  .nd-challenge-head { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .5rem; margin: 0 0 .25rem; }
  .nd-challenge-title { flex: 1 1 10rem; margin: 0; font-size: 10.5pt; font-weight: 700; color: var(--post-name-text-color, #117743); }
  .nd-challenge-body { margin: .5rem 0 0; padding: .5rem 0 0; border-top: 1px dashed var(--post-form-field-input-border-color, #aaa); }
  .nd-challenge-body .nd-input { width: min(100%, 26rem); }
  .nd-challenge-body .nd-input[inputmode="numeric"] { width: 7rem; }
  .nd-rule { margin: .5rem 0; padding: .5rem; border: 1px solid var(--post-form-field-input-border-color, #aaa); }
  .nd-rule-head { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .5rem; margin: 0 0 .25rem; }
  .nd-more > summary { margin: .25rem 0; font-weight: 700; cursor: pointer; }
  .nd-choice { display: inline-flex; align-items: center; gap: .25rem; margin-right: .75rem; }
  .nd-changes { margin: 0 0 .5rem; padding-left: 1.25rem; }
  .nd-input[data-nd-input="owner"], .nd-input[data-nd-input="name"] { width: 14rem; }
  select.nd-input { max-width: 100%; }
  .nd-requirements { margin: .25rem 0 .5rem; padding: 0 0 0 1.25rem; }
  .nd-requirement[data-nd-met="true"] { color: var(--post-name-text-color, #117743); }
  .nd-requirement[data-nd-met="false"] { color: var(--mod-queue-alert-color, #d00); font-weight: 700; }
  .nd-request { margin: .5rem 0 0; padding: .5rem; border: 1px dashed var(--homepage-box-border-color, #800); }
  .nd-preview { margin: 0 0 .5rem; padding: .25rem .5rem; font: 12px/1.4 monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 20rem; overflow: auto; color: var(--post-form-field-input-color, #000); background-color: var(--post-form-field-input-background-color, #fff); border: var(--post-form-field-input-border, 1px solid #aaa); }
</style>
</head>
<body class="yotsuba">
<main>
<h1>Node dashboard</h1>
<p>The Bitsocial node this build runs on your computer: it hosts the boards you create and reads the others.</p>
<div id="node-dashboard"></div>
<p><a href="../../index.html">Back to 5chan</a></p>
</main>
<script src="../../${NODE_CLIENT_FILE}"></script>
<script src="../node-start.js"></script>
<script src="../../${NODE_DASHBOARD_MODULE}"></script>
<script src="dashboard.js"></script>
</body>
</html>
`
}

async function writeNodeDashboard (masked, dirs) {
  const stylesheet = STYLESHEET.exec(masked)?.[1]
  if (stylesheet === undefined) throw new Error("5chan hooks: the built index.html names no assets/src-*.css stylesheet -- upstream's build changed shape")
  const target = join(dirs.static, NODE_DASHBOARD_FILE)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, dashboardPage(stylesheet))
  await writeFile(join(dirs.static, NODE_DASHBOARD_SCRIPT), await readFile(new URL('bridge/node-dashboard.js', import.meta.url)))
}

/** The module entry is held: no browser runs it until node-start.js gives it its type back, once the page is parsed. */
function holdModuleEntry (masked) {
  const entries = [...masked.matchAll(MODULE_ENTRY)]
  if (entries.length === 0 && masked.includes(`<script type="${HELD_TYPE}"`)) return masked
  if (entries.length !== 1) throw new Error(`5chan hooks: expected one module entry ./assets/index-*.js in the built index.html, found ${String(entries.length)} -- upstream's build changed shape`)
  return masked.replace(MODULE_ENTRY, (_all, attributes) => `<script type="${HELD_TYPE}"${attributes}></script>`)
}

/** The helper scripts are copied beside the page and loaded last in the head, after the bridge that reads them. */
async function addHelperScripts (masked, dirs) {
  for (const name of HELPER_SCRIPTS) {
    const target = join(dirs.static, helperScriptFile(name))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, await readFile(new URL(`bridge/${name}`, import.meta.url)))
  }
  const tags = HEAD_SCRIPTS.map((src) => `<script src="${src}"></script>`)
  if (tags.every((tag) => masked.includes(tag))) return masked
  if (!masked.includes('</head>')) throw new Error("5chan hooks: the built index.html has no </head> to load the helper scripts before -- upstream's build changed shape")
  return masked.replace('</head>', () => `${tags.join('\n')}\n</head>`)
}

export async function transformHtml (html, { dirs }) {
  const { masked, restore } = withoutComments(html)
  const moved = await moveInlineScripts(masked, dirs)
  await writeNodeDashboard(moved, dirs)
  return restore(await addHelperScripts(holdModuleEntry(moved), dirs))
}

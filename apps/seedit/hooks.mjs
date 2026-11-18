// Edits to the built index.html, for a policy the Electron window does not have (the served page's script-src admits
// no inline script) and for the node this build runs:
//
// 1. The two executable inline scripts of upstream's index.html (the static-shell paint, and the `/#` redirect) move
//    to files in the served tree, each loaded where it stood. The paint moves byte for byte. The redirect is written
//    again, because it sends a deep link such as /u/name to `/#/u/name` from the root of the host, which on a path
//    gateway (/ipfs/<cid>/) leaves the app. The file takes the app's root from where it is itself loaded.
// 2. The module entry is typed `orivon-held-module`, so no browser runs it until orivon/node-start.js, which starts
//    the node, gives it its type back once the page is parsed.
// 3. Five scripts of the port's own are added to the head, in the order they load: the three that drive image hosts,
//    get a Turnstile token and show third-party embeds (bridge/webview-*.js), node-client.js from the node bundle, and
//    node-start.js.
//
// 4. Two edits in upstream's built code, made once the tree is written (`finishTree`; the README says why):
//    - the hook that reports the RPC connection (`usePkcRpcSettings`) starts in the state `initializing`, which the
//      create-community page takes for "not connected" and sends the person home: the edit starts it from the connection's state.
//    - the create page's effect for a community it made lists `subscribe`, which the hook renews on every error the
//      second call adds: the effect runs about 200 times a second for 13 seconds, with the node idle. The edit lists the community alone.
//
// Beside them, the node dashboard the app's "node" link opens: this app's frame (its wording and its look, from the app's own built
// stylesheet), the script that mounts the node app's dashboard module in it, which draws what the node says, and the script that
// gives its body the theme (light or dark) the person chose in the app.
//
// A document already rewritten is returned as it is.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const INLINE_SCRIPT_COUNT = 2
export const inlineScriptFile = (index) => `orivon/inline-script-${String(index + 1)}.js`
export const NODE_DASHBOARD_FILE = 'orivon/node/index.html'
export const NODE_DASHBOARD_SCRIPT = 'orivon/node/dashboard.js'
/** The head script that puts the theme seedit is wearing on the dashboard's body. */
export const NODE_THEME_SCRIPT = 'orivon/node/theme.js'
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

const ASSETS_DIR = 'assets'
const RPC_STATE_HOOK = /(?<before>\[\w+,\w+\]=\(0,(?<react>\w+)\.useState\)\()`initializing`(?<after>\),\[\w+,\w+\]=\(0,\k<react>\.useState\)\(\[\]\);\(0,\k<react>\.useEffect\)\(\(\)=>\{if\(!\w+\|\|!\w+\|\|!(?<client>\w+)\)return;\k<client>\.settings!=null&&)/g
/** What the edit leaves in the code: the first state is the connection's own, `initializing` only when it has none. */
export const RPC_STATE_SEEDED = /\.useState\)\(\w+\?\.state\|\|`initializing`\),\[\w+,\w+\]=\(0,\w+\.useState\)\(\[\]\)/

/** The code with the first state of `usePkcRpcSettings` read from the connection, and how many places changed. */
export function seedRpcState (code) {
  let edits = 0
  const seeded = code.replace(RPC_STATE_HOOK, (...args) => {
    edits += 1
    const { before, after, client } = args.at(-1)
    return `${before}${client}?.state||\`initializing\`${after}`
  })
  return { code: seeded, edits }
}

const CREATED_EFFECT = /(?<head>\(0,[\w$]+\.useEffect\)\(\(\)=>\{(?<created>[\w$]+)&&\(console\.log\(`createdCommunity`,\k<created>\),alert\(`community created, address: \$\{[^}]*\}`\),[\w$]+&&\k<created>\.address&&[\w$]+\(\),[\w$]+\(\),\k<created>\.address&&[\w$]+\([\w$]+\(\k<created>\.address\)\)\)\},)\[\k<created>(?:,[\w$]+)+\]\)/g
/** What the edit leaves in the code: the effect that follows a created community lists the community alone. */
export const CREATED_EFFECT_KEYED = /alert\(`community created, address: \$\{[^}]*\}`\),[\w$]+&&[\w$]+\.address&&[\w$]+\(\),[\w$]+\(\),[\w$]+\.address&&[\w$]+\([\w$]+\([\w$]+\.address\)\)\)\},\[[\w$]+\]\)/

/** The code with the effect that follows a created community listing the community alone, and how many places changed. */
export function keyCreatedEffect (code) {
  let edits = 0
  const keyed = code.replace(CREATED_EFFECT, (...args) => {
    edits += 1
    const { head, created } = args.at(-1)
    return `${head}[${created}])`
  })
  return { code: keyed, edits }
}

/** One edit made in every built script that holds its place: exactly one place in the tree is edited or found edited, and a tree with none is a build the edit no longer fits. */
async function editBuiltScripts (dirs, { marker, edit, edited, what }) {
  const folder = join(dirs.static, ASSETS_DIR)
  let done = 0
  let already = 0
  for (const name of (await readdir(folder)).filter((file) => file.endsWith('.js'))) {
    const code = await readFile(join(folder, name), 'utf8')
    if (!code.includes(marker)) continue
    const { code: changed, edits } = edit(code)
    if (edits > 0) await writeFile(join(folder, name), changed)
    done += edits
    if (edits === 0 && edited.test(code)) already += 1
  }
  if (done + already !== 1) {
    throw new Error(`seedit hooks: expected one ${what} in the built scripts, edited ${String(done)} and found ${String(already)} already edited -- upstream's build changed shape`)
  }
}

/** Runs once every file of the tree is written. */
export async function finishTree ({ dirs }) {
  await editBuiltScripts(dirs, { marker: '`initializing`', edit: seedRpcState, edited: RPC_STATE_SEEDED, what: 'usePkcRpcSettings hook' })
  await editBuiltScripts(dirs, { marker: '`createdCommunity`', edit: keyCreatedEffect, edited: CREATED_EFFECT_KEYED, what: 'effect of a created community' })
}

/** Upstream's HTML can carry comments that contain the text `<script>`, so they are set aside first. */
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
    throw new Error(`seedit hooks: expected ${String(INLINE_SCRIPT_COUNT)} inline <script> elements with one /# redirect in the built index.html, found ${String(scripts.length)} with ${String(redirects.length)} -- upstream's index.html changed shape`)
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
<script src="theme.js"></script>
<title>Node dashboard</title>
<link rel="stylesheet" href="../../${stylesheet}">
<style>
  [hidden] { display: none !important; }
  main { max-width: 46rem; margin: 2rem auto; padding: 0 1rem; color: var(--text); font: 14px/1.5 arial, helvetica, sans-serif; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { margin: 0 0 .75rem; line-height: 1.5; }
  dd { margin: 0; overflow-wrap: anywhere; }
  a { color: var(--link); }
  .nd-status { font-size: 1.1rem; margin: 1rem 0 .25rem; }
  .nd-stats, .nd-facts { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1.5rem; margin: 0 0 1rem; }
  .nd-section-title { margin: 1.25rem 0 .5rem; font-size: 1.1rem; font-weight: 700; color: var(--text-primary); }
  .nd-note { color: var(--text-info); }
  .nd-error, .nd-field-error, .nd-form-message[data-nd-failed="true"] { color: var(--red); font-weight: 700; }
  .nd-board { margin: 0 0 .75rem; padding: .75rem; background: var(--background-primary); border: 1px solid var(--border-primary); border-radius: 4px; }
  .nd-board-head { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin: 0 0 .5rem; }
  .nd-address { flex: 1 1 14rem; margin: 0; font-size: 1rem; font-weight: 700; color: var(--text-primary); overflow-wrap: anywhere; }
  .nd-badge { padding: 0 8px; font-size: 12px; border: 1px solid var(--border-primary); border-radius: 10px; color: var(--text-info); }
  .nd-badge[data-nd-state="running"] { color: var(--green); border-color: var(--green); }
  .nd-badge[data-nd-state="backoff"] { color: var(--red); border-color: var(--red); }
  .nd-form { margin: 0; }
  .nd-field { margin: 0 0 .75rem; }
  .nd-label { display: block; font-weight: 700; color: var(--text-primary); }
  .nd-control { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .5rem; padding: .25rem 0 0; }
  .nd-input { width: 7rem; padding: 2px 6px; font: inherit; color: var(--text-input); background: var(--background); border: 1px solid var(--border-text); border-radius: 3px; }
  select.nd-input { width: auto; max-width: 100%; }
  .nd-hint { font-size: 12px; color: var(--text-info); overflow-wrap: anywhere; }
  .nd-field-error { display: block; font-size: 12px; }
  .nd-actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
  .nd-form-message { margin: .25rem 0 0; min-height: 1.2em; }
  .nd-button { padding: 4px 12px; font: inherit; color: #fff; background: var(--button-background-color); border: 1px solid var(--button-border-bottom); border-radius: 3px; cursor: pointer; }
  .nd-button:hover { background: var(--button-background-color-hover); }
  .nd-button:disabled { opacity: .6; cursor: default; }
  .nd-challenge { margin: 0 0 .5rem; padding: .5rem .75rem; border: 1px solid var(--border-primary); border-radius: 4px; }
  .nd-challenge-head { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .5rem; margin: 0 0 .25rem; }
  .nd-challenge-title { flex: 1 1 10rem; margin: 0; font-size: 1rem; font-weight: 700; color: var(--text-primary); }
  .nd-challenge-body { margin: .5rem 0 0; padding: .5rem 0 0; border-top: 1px dashed var(--border-primary); }
  .nd-challenge-body .nd-input { width: min(100%, 26rem); }
  .nd-challenge-body .nd-input[inputmode="numeric"] { width: 7rem; }
  .nd-rule { margin: .5rem 0; padding: .5rem; border: 1px solid var(--border-primary); border-radius: 4px; }
  .nd-rule-head { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .5rem; margin: 0 0 .25rem; }
  .nd-more > summary { margin: .25rem 0; font-weight: 700; cursor: pointer; }
  .nd-choice { display: inline-flex; align-items: center; gap: .25rem; margin-right: .75rem; }
  .nd-changes { margin: 0 0 .5rem; padding-left: 1.25rem; }
  .nd-input[data-nd-input="owner"], .nd-input[data-nd-input="name"] { width: 14rem; }
  select.nd-input { max-width: 100%; }
  .nd-requirements { margin: .25rem 0 .5rem; padding: 0 0 0 1.25rem; }
  .nd-requirement[data-nd-met="true"] { color: var(--green); }
  .nd-requirement[data-nd-met="false"] { color: var(--red); font-weight: 700; }
  .nd-request { margin: .5rem 0 0; padding: .5rem; border: 1px dashed var(--border-primary); border-radius: 4px; }
  .nd-preview { margin: 0 0 .5rem; padding: .25rem .5rem; font: 12px/1.4 monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 20rem; overflow: auto; color: var(--text-input); background: var(--background); border: 1px solid var(--border-text); border-radius: 3px; }
</style>
</head>
<body class="dark">
<main>
<h1>Node dashboard</h1>
<p>The Bitsocial node this build runs on your computer: it hosts the communities you create and reads the others.</p>
<div id="node-dashboard"></div>
<p><a href="../../index.html">Back to seedit</a></p>
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
  if (stylesheet === undefined) throw new Error("seedit hooks: the built index.html names no assets/src-*.css stylesheet -- upstream's build changed shape")
  const target = join(dirs.static, NODE_DASHBOARD_FILE)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, dashboardPage(stylesheet))
  await writeFile(join(dirs.static, NODE_DASHBOARD_SCRIPT), await readFile(new URL('bridge/node-dashboard.js', import.meta.url)))
  await writeFile(join(dirs.static, NODE_THEME_SCRIPT), await readFile(new URL('bridge/node-theme.js', import.meta.url)))
}

/** The module entry is held: no browser runs it until node-start.js gives it its type back, once the page is parsed. */
function holdModuleEntry (masked) {
  const entries = [...masked.matchAll(MODULE_ENTRY)]
  if (entries.length === 0 && masked.includes(`<script type="${HELD_TYPE}"`)) return masked
  if (entries.length !== 1) throw new Error(`seedit hooks: expected one module entry ./assets/index-*.js in the built index.html, found ${String(entries.length)} -- upstream's build changed shape`)
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
  if (!masked.includes('</head>')) throw new Error("seedit hooks: the built index.html has no </head> to load the helper scripts before -- upstream's build changed shape")
  return masked.replace('</head>', () => `${tags.join('\n')}\n</head>`)
}

export async function transformHtml (html, { dirs }) {
  const { masked, restore } = withoutComments(html)
  const moved = await moveInlineScripts(masked, dirs)
  await writeNodeDashboard(moved, dirs)
  return restore(await addHelperScripts(holdModuleEntry(moved), dirs))
}

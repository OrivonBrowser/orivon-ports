// The page that runs the wiki server. It unpacks upstream's install tree into
// the app's files, makes the wiki folder with upstream's own `--init server`
// on the first run, forks the bundled server into a Worker (through the Node
// shim, bundled beside this file), and shows what the server serves in a
// <webview>. Every decision is plan.js's; this file is the DOM, the fork and
// the files. The files go through the shim's `fs/promises`, which queues the
// calls and asks again when the broker's per-origin rate limit refuses one:
// the raw `orivon.fs` calls do neither, and the tree is thousands of calls.
//
// ORIVON_INSTALL_PARENT, ORIVON_INSTALL_STAMP, ORIVON_WIKI_DIR and
// ORIVON_VIRTUAL_ROOT are build-time constants (esbuild.orivon.config.mjs,
// `define`): the install tree lives in a directory named by its stamp, the
// same one the server is told to boot from.

import { fork } from 'child_process'
import fsp from 'fs/promises'
import {
  addressInUseDelay, APP_URL, appendLog, createPacer, downloadNotice, EMPTY_LOG, exitText, forEachLimited, heldPortText, initArgs, initDone,
  installMismatch, installNeeded, isAddressInUse, isReady, layout, logText, packMismatch, parentOf, parseInstall, popupOutcome, PORT,
  serverArgs, serverEnv, staleInstalls, WRITES_PER_SECOND, wikiExists
} from './plan.js'

const INSTALL_PARENT = ORIVON_INSTALL_PARENT
const INSTALL = `${INSTALL_PARENT}/${ORIVON_INSTALL_STAMP}`
const PARENT_PATH = `${ORIVON_VIRTUAL_ROOT}/${INSTALL_PARENT}`
const INSTALL_PATH = `${ORIVON_VIRTUAL_ROOT}/${INSTALL}`
const WIKI_PATH = `${ORIVON_VIRTUAL_ROOT}/${ORIVON_WIKI_DIR}`
const SERVER_PATH = new URL('server.mjs', location.href).pathname
const MAX_NOTICES = 5
const VIEW_READY_MS = 15_000
const WRITE_LANES = 8

const $ = (id) => document.getElementById(id)

let log = EMPTY_LOG
let view = null
let ownServerStopped = false

function status (text) {
  $('status').textContent = text
}

function showLog (chunk) {
  log = appendLog(log, chunk)
  const pre = $('log-text')
  const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8
  pre.textContent = logText(log)
  if (atEnd) pre.scrollTop = pre.scrollHeight
}

function notice (text) {
  const list = $('notices')
  const item = document.createElement('li')
  const message = document.createElement('span')
  message.textContent = text
  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.textContent = 'Dismiss'
  dismiss.addEventListener('click', () => item.remove())
  item.append(message, dismiss)
  list.append(item)
  while (list.children.length > MAX_NOTICES) list.firstElementChild.remove()
}

function decoderFor () {
  const decoder = new TextDecoder()
  return (chunk) => (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))
}

// --- the install tree -------------------------------------------------------

async function storedInstall () {
  try {
    return parseInstall(new TextDecoder().decode(await fsp.readFile(`${INSTALL_PATH}/install.json`)))
  } catch {
    return null
  }
}

/** Writes upstream's kernel, core, plugins and editions where the server reads them, when the served ones are not already there. */
async function materialise () {
  const response = await fetch('install/install.json', { cache: 'no-store' })
  if (!response.ok) throw new Error(`install/install.json answered ${String(response.status)}`)
  const served = parseInstall(await response.text())
  const mismatch = installMismatch(served, ORIVON_INSTALL_STAMP)
  if (mismatch !== null) throw new Error(mismatch)
  if (!installNeeded(served, await storedInstall())) return
  status('Preparing the wiki server...')
  const packResponse = await fetch('install/pack.bin', { cache: 'no-store' })
  if (!packResponse.ok) throw new Error(`install/pack.bin answered ${String(packResponse.status)}`)
  const pack = new Uint8Array(await packResponse.arrayBuffer())
  const wrong = packMismatch(served.files, pack.length)
  if (wrong !== null) throw new Error(wrong)
  const paced = createPacer(WRITES_PER_SECOND)
  const made = new Map()
  const ensureDir = (dir) => {
    if (!made.has(dir)) {
      made.set(dir, paced().then(async () => await fsp.mkdir(`${INSTALL_PATH}/${dir}`, { recursive: true })))
    }
    return made.get(dir)
  }
  let done = 0
  await forEachLimited(layout(served.files), WRITE_LANES, async ({ name, offset, size }) => {
    await ensureDir(parentOf(name))
    await paced()
    await fsp.writeFile(`${INSTALL_PATH}/${name}`, pack.slice(offset, offset + size))
    done += 1
    if (done % 100 === 0) status(`Preparing the wiki server (${String(done)} of ${String(served.files.length)})...`)
  })
  // Last, so a run cut short is written again rather than trusted.
  await fsp.writeFile(`${INSTALL_PATH}/install.json`, new TextEncoder().encode(JSON.stringify(served)))
}

/** Removes the install trees of other versions. Only after this page started the server: the port was free, so no server is reading one. */
async function removeOtherInstalls () {
  try {
    for (const name of staleInstalls((await fsp.readdir(PARENT_PATH)).map(String), ORIVON_INSTALL_STAMP)) {
      await fsp.rm(`${PARENT_PATH}/${name}`, { recursive: true, force: true }).catch(() => undefined)
    }
  } catch { /* nothing to clean, or a file in use: the next start tries again */ }
}

// --- the server -------------------------------------------------------------

/** Forks the bundled server with `args`; `onData` hears each chunk of its output, `onEnd` its exit, or the error that kept it from running (`onEnd(null, null, error)`). */
function forkServer (args, onData, onEnd) {
  const child = fork(SERVER_PATH, args, { silent: true, env: serverEnv(INSTALL_PATH) })
  for (const stream of [child.stdout, child.stderr]) {
    const decode = decoderFor()
    stream?.on('data', (chunk) => onData(decode(chunk)))
  }
  child.on('error', (error) => {
    onData(`${String(error?.message ?? error)}\n`)
    onEnd(null, null, error)
  })
  child.on('close', (code, signal) => onEnd(code, signal))
  return child
}

/** One start of the server: `'started'` when it listens, `'in-use'` when the port is held. */
function startOnce () {
  return new Promise((resolve, reject) => {
    let settled = false
    let ready = false
    let recent = ''
    const child = forkServer(serverArgs(WIKI_PATH), (text) => {
      showLog(text)
      if (settled) return
      recent = (recent + text).slice(-4096)
      if (isReady(recent)) {
        settled = ready = true
        resolve('started')
      } else if (isAddressInUse(recent)) {
        settled = true
        child.kill()
        resolve('in-use')
      }
    }, (code, signal, error) => {
      if (!settled) {
        settled = true
        reject(new Error(error === undefined ? exitText(code, signal, false) : `The server did not start: ${String(error?.message ?? error)}`))
      } else if (ready) {
        ownServerStopped = true
        serverStopped(exitText(code, signal, true))
      }
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Starts the server and settles when it listens: `'started'`, or `'reused'`
 * when the port stays held. The holder is the server another tab of this app
 * started, since a child outlives the tab that forked it (this page then shows
 * that one and leaves it alone), or another program. A port this page's own
 * server held a moment ago is given a few tries to be released.
 */
async function startServer () {
  for (let attempt = 0; ; attempt++) {
    if (await startOnce() === 'started') return 'started'
    const wait = addressInUseDelay(attempt, ownServerStopped)
    if (wait === null) return 'reused'
    status(`Waiting for port ${String(PORT)} to be released...`)
    await sleep(wait)
  }
}

function serverStopped (text) {
  status(text)
  $('restart').hidden = false
}

/** Runs one of upstream's own commands to its end: `{ code, output }`, with a null code when it could not run at all. */
function runCommand (args) {
  return new Promise((resolve) => {
    let output = ''
    try {
      forkServer(args, (text) => { output += text }, (code) => resolve({ code, output }))
    } catch (error) {
      resolve({ code: null, output: `${String(error?.message ?? error)}\n` })
    }
  })
}

// --- the wiki folder --------------------------------------------------------

async function wikiMade () {
  try {
    return wikiExists((await fsp.readdir(WIKI_PATH)).map(String))
  } catch {
    return false
  }
}

/** Makes the wiki folder with upstream's `--init server` when the app's files hold none. A folder that exists is left as it is. */
async function ensureWiki () {
  if (await wikiMade()) return
  status('Making your wiki...')
  const { code, output } = await runCommand(initArgs(WIKI_PATH))
  showLog(output)
  // Another tab may have made it meanwhile: `--init` then refuses a folder that is not empty.
  if (!initDone(output, code) && !await wikiMade()) {
    $('log').open = true
    throw new Error('The wiki was not made. The server log below says why.')
  }
}

// --- the page the server serves ---------------------------------------------

function once (target, name, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${name} within ${String(ms / 1000)} s`)), ms)
    target.addEventListener(name, () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

/** Loads the server's page into the <webview>; true when it loaded. */
async function showApp () {
  if (view === null) {
    view = document.createElement('webview')
    view.setAttribute('aria-label', 'TiddlyWiki')
    // The element starts on about:blank: a document under web.embed's local pattern loads only while this app holds the listener.
    view.setAttribute('src', 'about:blank')
    view.addEventListener('orivon-popup', (event) => {
      const outcome = popupOutcome(event.detail)
      if (outcome.kind === 'open') window.open(outcome.url, '_blank', 'noopener,noreferrer')
      else notice(outcome.text)
    })
    view.addEventListener('orivon-download', (event) => notice(downloadNotice(event.detail)))
    const attached = once(view, 'did-finish-load', VIEW_READY_MS)
    $('stage').append(view)
    await attached
  }
  try {
    await view.loadURL(APP_URL)
    $('reload').hidden = false
    return true
  } catch (error) {
    notice(`The wiki's page did not load (${String(error?.message ?? error)}). Another program may be using port ${String(PORT)}, or the server has stopped.`)
    $('reload').hidden = false
    return false
  }
}

// --- the whole -------------------------------------------------------------

async function bringUp () {
  $('restart').hidden = true
  status('Starting the server...')
  try {
    const how = await startServer()
    status(how === 'started' ? 'The server is running. Your tiddlers are saved in this app\'s files.' : 'Using the server another tab of this app already started.')
    if (how === 'started') await navigator.locks.request('wikifolder-install', removeOtherInstalls)
    const loaded = await showApp()
    if (how === 'reused' && !loaded) {
      status(heldPortText())
      $('restart').hidden = false
    }
  } catch (error) {
    status(String(error?.message ?? error))
    $('restart').hidden = false
    $('log').open = true
  }
}

async function main () {
  try {
    // One tab writes the install tree and makes the wiki at a time; the others wait, then find them current.
    await navigator.locks.request('wikifolder-install', materialise)
    await navigator.locks.request('wikifolder-install', ensureWiki)
  } catch (error) {
    status(`Could not prepare the wiki: ${String(error?.message ?? error)}`)
    return
  }
  await bringUp()
}

$('restart').addEventListener('click', () => { void bringUp() })
$('reload').addEventListener('click', () => { if (view !== null) void showApp() })
void main()

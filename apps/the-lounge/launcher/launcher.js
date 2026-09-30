// The page that runs The Lounge. It writes upstream's install tree into the
// app's files, forks the bundled server into a Worker (through the Node shim,
// bundled beside this file), makes the first account with upstream's own
// `add` command, and shows what the server serves in a <webview>. Every
// decision is plan.js's; this file is the DOM, the fork and the files.
//
// ORIVON_INSTALL_PARENT, ORIVON_INSTALL_STAMP, ORIVON_HOME_DIR and
// ORIVON_VIRTUAL_ROOT are build-time constants (esbuild.orivon.config.mjs,
// `define`): the install tree lives in a directory named by its stamp, the
// same one the server bundle was built to read.

import { fork } from 'child_process'
import {
  accountCreated, accountProblems, addArgs, addressInUseDelay, APP_URL, appendLog, downloadNotice, EMPTY_LOG, exitText,
  forEachLimited, hasAccounts, heldPortText, installMismatch, installNeeded, installUrl, isAddressInUse, isReady, logText,
  parentOf, parseInstall, popupOutcome, PORT, serverArgs, serverEnv, staleInstalls
} from './plan.js'

const INSTALL_PARENT = ORIVON_INSTALL_PARENT
const INSTALL = `${INSTALL_PARENT}/${ORIVON_INSTALL_STAMP}`
const HOME = ORIVON_HOME_DIR
const HOME_PATH = `${ORIVON_VIRTUAL_ROOT}/${HOME}`
const SERVER_PATH = new URL('server.mjs', location.href).pathname
const MAX_NOTICES = 5
const VIEW_READY_MS = 15_000
const FETCH_LANES = 4

const $ = (id) => document.getElementById(id)
const fs = () => window.orivon.fs

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
    return parseInstall(new TextDecoder().decode(await fs().readFile(`${INSTALL}/install.json`)))
  } catch {
    return null
  }
}

/** Writes upstream's client and defaults where the server reads them, when the served ones are not already there. */
async function materialise () {
  const response = await fetch('install/install.json', { cache: 'no-store' })
  if (!response.ok) throw new Error(`install/install.json answered ${String(response.status)}`)
  const served = parseInstall(await response.text())
  const mismatch = installMismatch(served, ORIVON_INSTALL_STAMP)
  if (mismatch !== null) throw new Error(mismatch)
  if (!installNeeded(served, await storedInstall())) return
  status('Preparing The Lounge...')
  const made = new Map()
  const ensureDir = (dir) => {
    if (!made.has(dir)) made.set(dir, fs().mkdir(`${INSTALL}/${dir}`, { recursive: true }))
    return made.get(dir)
  }
  let done = 0
  await forEachLimited(served.files, FETCH_LANES, async (file) => {
    const part = await fetch(installUrl(file), { cache: 'no-store' })
    if (!part.ok) throw new Error(`install/${file} answered ${String(part.status)}`)
    const bytes = new Uint8Array(await part.arrayBuffer())
    await ensureDir(parentOf(file))
    await fs().writeFile(`${INSTALL}/${file}`, bytes)
    done += 1
    status(`Preparing The Lounge (${String(done)} of ${String(served.files.length)})...`)
  })
  // Last, so a run cut short is written again rather than trusted.
  await fs().writeFile(`${INSTALL}/install.json`, new TextEncoder().encode(JSON.stringify(served)))
}

/** Removes the install trees of other versions. Only after this page started the server: the port was free, so no server is reading one. */
async function removeOtherInstalls () {
  try {
    for (const name of staleInstalls((await fs().readdir(INSTALL_PARENT)).map(String), ORIVON_INSTALL_STAMP)) {
      await fs().rm(`${INSTALL_PARENT}/${name}`, { recursive: true, force: true }).catch(() => undefined)
    }
  } catch { /* nothing to clean, or a file in use: the next start tries again */ }
}

// --- the server -------------------------------------------------------------

/** Forks the bundled server with `args`; `onData` hears each chunk of its output, `onEnd` its exit, or the error that kept it from running (`onEnd(null, null, error)`). */
function forkServer (args, onData, onEnd) {
  const child = fork(SERVER_PATH, args, { silent: true, env: serverEnv(HOME_PATH) })
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
    const child = forkServer(serverArgs(), (text) => {
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

// --- the first account ------------------------------------------------------

async function accountsExist () {
  try {
    return hasAccounts(await fs().readdir(`${HOME}/users`))
  } catch {
    return false
  }
}

/** Shows the form and settles when an account exists: made by upstream's `add` here, or by another tab. */
function askForAccount () {
  const section = $('setup')
  const form = $('setup-form')
  const errors = $('setup-errors')
  status('Waiting for you to create an account.')
  section.hidden = false
  $('account-name').focus()
  const list = (texts) => errors.replaceChildren(...texts.map((text) => Object.assign(document.createElement('li'), { textContent: text })))
  return new Promise((resolve) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const values = {
        name: $('account-name').value,
        password: $('account-password').value,
        confirm: $('account-confirm').value,
        keepHistory: $('account-history').checked
      }
      const problems = accountProblems(values)
      list(problems)
      if (problems.length > 0) return
      $('setup-submit').disabled = true
      status('Creating your account...')
      try {
        // `add` looks for the users directory and does not make it; the server's own start-up does.
        await fs().mkdir(`${HOME}/users`, { recursive: true })
        const { code, output } = await runCommand(addArgs(values))
        // Another tab may have made an account meanwhile: `add` then exits 0 with "already exists".
        if (accountCreated(output, code) || await accountsExist()) {
          section.hidden = true
          resolve()
          return
        }
        showLog(`${output}\n`)
        list(['The account was not created. The server log below says why.'])
      } catch (error) {
        showLog(`${String(error?.message ?? error)}\n`)
        list([`The account was not created: ${String(error?.message ?? error)}`])
      }
      $('log').open = true
      $('setup-submit').disabled = false
      status('The account was not created.')
    })
  })
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
    view.setAttribute('aria-label', 'The Lounge')
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
    notice(`The Lounge's page did not load (${String(error?.message ?? error)}). Another program may be using port ${String(PORT)}, or the server has stopped.`)
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
    status(how === 'started' ? 'The server is running.' : 'Using the server another tab of this app already started.')
    if (how === 'started') await navigator.locks.request('the-lounge-install', removeOtherInstalls)
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
    // One tab writes the install tree at a time; the others wait, then find it current.
    await navigator.locks.request('the-lounge-install', materialise)
    if (!await accountsExist()) await askForAccount()
  } catch (error) {
    status(`Could not prepare The Lounge: ${String(error?.message ?? error)}`)
    return
  }
  await bringUp()
}

$('restart').addEventListener('click', () => { void bringUp() })
$('reload').addEventListener('click', () => { if (view !== null) void showApp() })
void main()

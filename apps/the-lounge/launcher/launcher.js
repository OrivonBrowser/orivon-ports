// The page that runs The Lounge. It writes upstream's install tree into the
// app's files, forks the bundled server into a Worker (through the Node shim,
// bundled beside this file), makes the first account with upstream's own
// `add` command, and shows what the server serves in a <webview>. Every
// decision is plan.js's; this file is the DOM, the fork and the files.
//
// ORIVON_INSTALL_DIR, ORIVON_HOME_DIR and ORIVON_VIRTUAL_ROOT are build-time
// constants (esbuild.orivon.config.mjs, `define`).

import { fork } from 'child_process'
import {
  accountCreated, accountProblems, addArgs, APP_URL, appendLog, directoriesOf, downloadNotice, EMPTY_LOG, exitText,
  hasAccounts, installNeeded, isAddressInUse, isReady, logText, parseInstall, popupOutcome, serverArgs, serverEnv
} from './plan.js'

const INSTALL = ORIVON_INSTALL_DIR
const HOME = ORIVON_HOME_DIR
const HOME_PATH = `${ORIVON_VIRTUAL_ROOT}/${HOME}`
const SERVER_PATH = new URL('server.mjs', location.href).pathname
const MAX_NOTICES = 5
const VIEW_READY_MS = 15_000

const $ = (id) => document.getElementById(id)
const fs = () => window.orivon.fs

let log = EMPTY_LOG
let view = null

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
  if (!installNeeded(served, await storedInstall())) return
  status('Preparing The Lounge...')
  await fs().rm(INSTALL, { recursive: true }).catch(() => undefined)
  await fs().mkdir(INSTALL, { recursive: true })
  for (const dir of directoriesOf(served.files)) await fs().mkdir(`${INSTALL}/${dir}`, { recursive: true })
  let done = 0
  for (const file of served.files) {
    const part = await fetch(`install/${file.split('/').map(encodeURIComponent).join('/')}`)
    if (!part.ok) throw new Error(`install/${file} answered ${String(part.status)}`)
    await fs().writeFile(`${INSTALL}/${file}`, new Uint8Array(await part.arrayBuffer()))
    done += 1
    status(`Preparing The Lounge (${String(done)} of ${String(served.files.length)})...`)
  }
  // Last, so a run cut short is written again rather than trusted.
  await fs().writeFile(`${INSTALL}/install.json`, new TextEncoder().encode(JSON.stringify(served)))
}

// --- the server -------------------------------------------------------------

/** Forks the bundled server with `args`; `onData` hears each chunk of its output, `onEnd` its exit. */
function forkServer (args, onData, onEnd) {
  const child = fork(SERVER_PATH, args, { silent: true, env: serverEnv(HOME_PATH) })
  for (const stream of [child.stdout, child.stderr]) {
    const decode = decoderFor()
    stream?.on('data', (chunk) => onData(decode(chunk)))
  }
  child.on('error', (error) => onData(`${String(error?.message ?? error)}\n`))
  child.on('close', (code, signal) => onEnd(code, signal))
  return child
}

/**
 * Starts the server and settles when it listens: `'started'`, or `'reused'`
 * when the port is already held. The port is held by the server another tab
 * of this app started, since a child outlives the tab that forked it; this
 * page then shows that one and leaves it alone.
 */
function startServer () {
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
        resolve('reused')
      }
    }, (code, signal) => {
      if (!settled) {
        settled = true
        reject(new Error(exitText(code, signal, false)))
      } else if (ready) {
        serverStopped(exitText(code, signal, true))
      }
    })
  })
}

function serverStopped (text) {
  status(text)
  $('restart').hidden = false
}

/** Runs one of upstream's own commands to its end. */
function runCommand (args) {
  return new Promise((resolve) => {
    let output = ''
    forkServer(args, (text) => { output += text }, (code) => resolve({ code, output }))
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

/** Shows the form and settles when upstream's `add` has made the account. */
function askForAccount () {
  const section = $('setup')
  const form = $('setup-form')
  const errors = $('setup-errors')
  status('Waiting for you to create an account.')
  section.hidden = false
  $('account-name').focus()
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
      errors.replaceChildren(...problems.map((text) => Object.assign(document.createElement('li'), { textContent: text })))
      if (problems.length > 0) return
      $('setup-submit').disabled = true
      status('Creating your account...')
      // `add` looks for the users directory and does not make it; the server's own start-up does.
      await fs().mkdir(`${HOME}/users`, { recursive: true })
      const { code, output } = await runCommand(addArgs(values))
      if (accountCreated(output, code)) {
        section.hidden = true
        resolve()
        return
      }
      showLog(`${output}\n`)
      $('setup-submit').disabled = false
      errors.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'The account was not created. The server log below says why.' }))
      $('log').open = true
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
  } catch (error) {
    notice(`The Lounge's page did not load (${String(error?.message ?? error)}). Another program may be using port 9000, or the server has stopped.`)
    $('reload').hidden = false
  }
}

// --- the whole -------------------------------------------------------------

async function bringUp () {
  $('restart').hidden = true
  status('Starting the server...')
  try {
    const how = await startServer()
    status(how === 'started' ? 'The server is running.' : 'Using the server another tab of this app already started.')
    await showApp()
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

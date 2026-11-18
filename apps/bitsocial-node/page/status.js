// The app's own page: starts the node through node-client.js and shows what it says. A node another tab or the person's
// own Bitsocial node already runs is shown as it is. The page's state is left in `window.bitsocialNodeApp` for a test to read.

const { startBitsocialNode, authKeyFrom, DEFAULT_PORTS } = globalThis.BitsocialNodeClient

const app = { handle: null, error: null, waiting: true }
globalThis.bitsocialNodeApp = app

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id))
const REACHABILITY = { public: 'Reachable from the internet', private: 'Not reachable from the internet (behind a router)', unknown: 'Not measured yet' }
const NODE_STATE = { unknown: 'Unknown', starting: 'Starting', up: 'Running', restarting: 'Restarting', failed: 'Failed' }

function render () {
  const snapshot = app.handle?.snapshot() ?? null
  $('state').textContent = app.error !== null ? 'Could not start' : app.waiting ? 'Waiting for permission' : snapshot === null ? 'Starting' : snapshot.running ? (snapshot.reused ? 'Running (already started)' : 'Running') : 'Starting'
  $('detail').textContent = app.error ?? ''
  $('node').textContent = snapshot === null ? '' : NODE_STATE[snapshot.node] ?? snapshot.node
  $('peer').textContent = snapshot?.peer ?? ''
  $('reach').textContent = snapshot === null ? '' : REACHABILITY[snapshot.reachability]
  $('peers').textContent = snapshot?.peers == null ? '' : String(snapshot.peers)
  $('rpc').textContent = app.handle === null ? '' : `ws://localhost:${app.handle.ports.rpc}/<key>`
  $('gateway').textContent = app.handle === null ? '' : app.handle.gatewayUrl
  $('errors').textContent = (snapshot?.errors ?? []).map((one) => `${one.where}: ${one.message}`).join('\n')
}

/** Before the person answers the permission question the tab is a plain page; the shell reloads it after the answer. */
const permitted = () => globalThis.crossOriginIsolated === true && typeof globalThis.orivon?.fs?.readFile === 'function'

async function main () {
  render()
  while (!permitted()) await new Promise((resolve) => setTimeout(resolve, 1000))
  app.waiting = false
  render()
  try {
    app.handle = await startBitsocialNode({ authKey: authKeyFrom(globalThis.localStorage), ports: DEFAULT_PORTS, origins: [globalThis.location.origin] })
    app.handle.on('status', render)
    app.handle.on('exit', render)
  } catch (error) {
    app.error = error instanceof Error ? error.message : String(error)
  }
  render()
}

main().catch((error) => { app.error = String(error); render() })

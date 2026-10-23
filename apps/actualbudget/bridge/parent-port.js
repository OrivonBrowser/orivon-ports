// Electron's utility process has `process.parentPort`: `on('message', ({ data }) => ...)` and
// `postMessage(value)`, the channel to the process that forked it. Upstream's backend uses exactly
// those two members (loot-core's connection/index.electron.ts). A forked child of an Orivon app has
// the Node channel instead, `process.on('message', value)` and `process.send(value)`, so this gives
// the process the two members over it. Nothing else of Electron's port is provided.

/** Installs `proc.parentPort` over `proc`'s Node IPC channel and returns it. */
export function installParentPort (proc) {
  const port = {
    on (event, listener) {
      if (event !== 'message') throw new Error(`process.parentPort.on('${String(event)}') is not provided: the backend listens for 'message' only`)
      proc.on('message', (data) => { listener({ data }) })
      return port
    },
    postMessage (value) {
      proc.send(value)
    }
  }
  proc.parentPort = port
  return port
}

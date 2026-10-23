// The four ways the bundle answers a channel the preload sends to main. Each registers on
// orivon-mvp's in-page bus, where the preload's `invoke`, `send` and `sendSync` reach it. The
// handlers take the call's arguments without the event: nothing here needs to know which window
// asked, because there is one.

import { ipcMain } from 'electron'

/** A channel name that is not a string is an `IPC.X` upstream no longer has; it would register as "undefined" and answer nothing. */
function named (channel) {
  if (typeof channel !== 'string') throw new Error(`a channel the bridge answers has no name (${String(channel)}): upstream's IPC table changed`)
}

/** A channel answered by running `run(...args)`; what it returns or throws is what the preload's caller gets. */
export function handle (channel, run) {
  named(channel)
  ipcMain.handle(channel, (_event, ...args) => run(...args))
}

/** A channel the preload sends and expects nothing back from. */
export function listen (channel, run) {
  named(channel)
  ipcMain.on(channel, (_event, ...args) => { run(...args) })
}

/** A channel the preload sends and waits for with `sendSync`: `run(...args)` is the answer, set before the call returns. */
export function sync (channel, run) {
  named(channel)
  ipcMain.on(channel, (event, ...args) => { event.returnValue = run(...args) })
}

/** A channel answered with one value (a fresh copy each time, because the page and the bundle share one realm) or the result of one function, whatever the arguments: the feature it asks about is not in this build. */
export function answer (channel, value) {
  named(channel)
  ipcMain.handle(channel, () => (typeof value === 'function' ? value() : structuredClone(value)))
}

/** A channel whose action Orivon cannot do. It rejects with a sentence the app shows as it shows any failure. */
export function refused (channel, what) {
  named(channel)
  ipcMain.handle(channel, () => {
    throw Object.assign(new Error(`${what} is not available in the Orivon build of ZenNotes.`), { name: 'OrivonPortRefusal', code: 'ORIVON_PORT_REFUSED' })
  })
}

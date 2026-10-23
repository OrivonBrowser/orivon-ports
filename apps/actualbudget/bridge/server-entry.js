// The backend bundle's entry: what upstream's desktop-electron/server.ts does in an Electron utility
// process, in a forked child of this app. The SQLite engine starts first (a top-level await in the
// shim's ready module). `actual-backend` is upstream's own loot-core bundle for the desktop app,
// `bundle.desktop.js`, resolved into the clone by esbuild.orivon.config.mjs; its text is not changed.
// The directories it reads and writes arrive in the environment (plan.js, backendEnv).

import 'orivon-node-shim/sqlite-ready'
import * as backend from 'actual-backend'
import { installParentPort } from './parent-port.js'
import { failurePayload, READY_TYPE } from './plan.js'

const port = installParentPort(process)

try {
  await backend.initApp(false)
  port.postMessage({ type: READY_TYPE })
} catch (error) {
  console.error('Failed to initialize the backend:', error)
  port.postMessage(failurePayload(error))
}

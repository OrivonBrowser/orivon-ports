// The bundle's entry: the answers to the preload's calls first (register.js), then the preload
// itself, which publishes `window.zen`. The start-up work (the app's files, the settings) is a
// promise the start script waits for before it loads upstream's renderer.

import './env.js'
import './register.js'
import 'zennotes-desktop/preload/index.ts'
import { start } from './main-process.js'
import { watchAssets } from './assets.js'
import { adjustHost } from './host.js'

adjustHost(globalThis.zen)
globalThis.__zennotesReady = start()
watchAssets({ root: document })

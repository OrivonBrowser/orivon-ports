// Registers the answers to the preload's calls. A module of its own, imported before the preload,
// because the preload makes one call when it loads and a call nobody answers yet is refused.

import { registerMainProcess } from './main-process.js'

registerMainProcess()

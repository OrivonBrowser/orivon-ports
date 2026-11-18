// Workaround, deletable together with shim-builtins.js: registers the builtins pkc-js requires at run time. The
// registry is imported by a name the build resolves to the shim's own source file, since v0.1.0 gives an app no
// public way to reach it (build/gap-registry.mjs).

import { registerBuiltin } from 'orivon-shim-registry'
import * as wt from 'worker_threads'
import * as sqlite from 'node:sqlite'
import { streamWebFor, workerThreadsFor } from './shim-builtins.js'

registerBuiltin('worker_threads', workerThreadsFor(wt))
registerBuiltin('sqlite', sqlite)
registerBuiltin('stream/web', streamWebFor(globalThis))

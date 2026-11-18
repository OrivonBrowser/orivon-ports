#!/usr/bin/env node
// Go/no-go 2 in the Orivon shell, headless, through heavy and the checkout's run-headless.mjs (nothing on the screen).
// Needs: ORIVON_MVP_ROOT (a built Orivon checkout), the built app (default out/bitsocial-node/static), kubo 0.43.x in KUBO_BIN.
// The run starts its own servers and kubo, because heavy runs Electron in a private network namespace.
// Usage: [DRIVE_MODE=start|restart|network|manager] node run.js <label>    Results: out/go-no-go/results/{shell,start,restart,network}-latest.json, and the console in
// out/go-no-go/shell-<label>.log. `shell-drive.js` says what each mode runs.

import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.env['ORIVON_MVP_ROOT']
if (root === undefined || root === '') throw new Error('set ORIVON_MVP_ROOT to a built Orivon checkout')
const here = dirname(fileURLToPath(import.meta.url))
const ports = resolve(here, '../../../../..')
const label = process.argv[2] ?? 'run'
mkdirSync(join(ports, 'out', 'go-no-go'), { recursive: true })
const log = createWriteStream(join(ports, 'out', 'go-no-go', `shell-${label}.log`))
const child = spawn(process.env['HEAVY'] ?? 'heavy', ['env', '-C', root, 'node', 'scripts/run-headless.mjs', 'npx', 'vitest', 'run', '--config', join(here, 'vitest-config.js')], {
  env: {
    ...process.env,
    HEAVY_REMOTE: '0',
    DRIVE_DIST: process.env['DRIVE_DIST'] ?? join(ports, 'out', 'bitsocial-node', 'static'),
    DRIVE_RESULTS: process.env['DRIVE_RESULTS'] ?? join(ports, 'out', 'go-no-go', 'results')
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.pipe(log, { end: false })
child.stderr.pipe(log, { end: false })
child.once('exit', (code) => {
  log.end()
  console.log(`run exit=${String(code)}`)
  process.exit(code ?? 1)
})

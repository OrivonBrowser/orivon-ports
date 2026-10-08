// Install-time helper for Ledger Wallet's library build: puts a thin wrapper
// in front of every `tsc` that pnpm linked into the clone's node_modules/.bin.
// Nothing of upstream's is edited; the wrapper lives in the gitignored clone
// and every install regenerates it. Why it is needed: ../README.md, Build notes.
//
//   - `--singleThreaded` (TypeScript 7 native only): the default parallel
//     checkers exceed 5 GB on @ledgerhq/react-ui; single-threaded peaks at 2.5 GB.
//   - exit status 2 becomes 0: at the pinned commit two coin modules carry
//     type errors of their own, and tsc still emits on status 2, but the
//     `tsc && tsc -m esnext` scripts stop before the second emit otherwise.
//     Any other status is passed through, so a crash still fails the build.
//
// Usage: node tsc-wrapper.config.mjs <clone root>
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (root === undefined) throw new Error('usage: node tsc-wrapper.config.mjs <clone root>')

const WINDOWS = process.platform === 'win32'
const SKIP = new Set(['node_modules', '.git', 'dist', 'lib', 'lib-es', 'build'])

/** Every directory up to four levels below the root whose node_modules/.bin holds a tsc. */
function binDirs (dir, depth, found) {
  const bin = join(dir, 'node_modules', '.bin')
  if (existsSync(join(bin, 'tsc')) || existsSync(join(bin, 'tsc.cmd'))) found.push(bin)
  if (depth === 0) return found
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !SKIP.has(entry.name) && !entry.name.startsWith('.')) binDirs(join(dir, entry.name), depth - 1, found)
  }
  return found
}

function isNativeTs (bin) {
  const original = join(bin, WINDOWS ? 'tsc.upstream.cmd' : 'tsc.upstream')
  try {
    return execFileSync(original, ['--version'], { encoding: 'utf8', shell: WINDOWS }).includes('Version 7')
  } catch {
    return false
  }
}

let wrapped = 0
for (const bin of binDirs(root, 4, [])) {
  if (!existsSync(join(bin, 'tsc.upstream')) && !existsSync(join(bin, 'tsc.upstream.cmd'))) {
    // Rename first, so the version probe below runs the upstream shim.
    for (const ext of ['', '.cmd', '.ps1']) {
      const original = join(bin, `tsc${ext}`)
      if (existsSync(original)) renameSync(original, join(bin, `tsc.upstream${ext}`))
    }
  }
  const flag = isNativeTs(bin) ? ' --singleThreaded' : ''
  const sh = `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\n"$basedir/tsc.upstream"${flag} "$@"\nstatus=$?\nif [ "$status" -eq 2 ]; then exit 0; fi\nexit $status\n`
  const cmd = `@ECHO off\r\ncall "%~dp0\\tsc.upstream.cmd"${flag} %*\r\nIF %ERRORLEVEL% EQU 2 EXIT /b 0\r\nEXIT /b %ERRORLEVEL%\r\n`
  const ps1 = `& "$PSScriptRoot/tsc.upstream.ps1"${flag} @args\r\nif ($LASTEXITCODE -eq 2) { exit 0 }\r\nexit $LASTEXITCODE\r\n`
  for (const [ext, body] of [['', sh], ['.cmd', cmd], ['.ps1', ps1]]) {
    if (existsSync(join(bin, `tsc.upstream${ext}`)) && !existsSync(join(bin, `tsc${ext}`))) {
      writeFileSync(join(bin, `tsc${ext}`), body, 'utf8')
      if (ext === '') chmodSync(join(bin, 'tsc'), 0o755)
      wrapped += 1
    }
  }
}
console.log(`ledger-wallet: wrapped ${String(wrapped)} tsc entr${wrapped === 1 ? 'y' : 'ies'}`)

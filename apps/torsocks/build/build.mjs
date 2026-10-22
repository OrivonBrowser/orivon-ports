// TorSocks' build, run by `orivon-port build torsocks` inside the Arti clone
// (out/torsocks/source, the recipe's pin). It writes the served tree to
// ./orivon-dist:
//
//   index.html, styles.css, assets/   the page (../page/), copied
//   app.js                            the page's code, bundled with Orivon's Node shim
//   bin/torsocksd.p2/                 the daemon (../daemon/), built for wasm32-wasip2
//                                     and transpiled for orivon-mvp's WASI 0.2 host
//
// The daemon is built in one directory per machine, RUST_ROOT, which holds its
// source copy, the patched crates, Cargo's home and target and the WASI SDK, so
// the build is the same bytes from any checkout. The Node tools are kept in
// out/torsocks/node-tools/. It needs Rust from rustup and ORIVON_MVP_ROOT
// (default ../orivon-mvp beside this repository).

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadShimPlugin, printWarnings } from '../../../src/build/esbuild-kit.mjs'
import { lockVersion, preparePatchedCrates, unlockPatched } from './crates.mjs'
import { ensureNodeTools, ensureRustTarget, ensureWasiSdk, findRust, RUST_TARGET, wasiBuildEnv } from './toolchain.mjs'
import { transpileComponent } from './transpile.mjs'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLONE = process.cwd()
const WORK = resolve(CLONE, '..')
const OUT = join(CLONE, 'orivon-dist')
const PROGRAM = 'torsocksd'
/**
 * Where the daemon is built: the same directory on every machine of a platform, because Rust's
 * crate hashes take in the compiler's flags, and the flags name this directory (README.md section
 * Design notes, Why the daemon is built in one place).
 */
const RUST_ROOT = process.platform === 'win32' ? join(process.env.SystemDrive ?? 'C:', '\\', 'orivon-torsocks-build') : '/tmp/orivon-torsocks-build'
const STAND_IN = '/torsocks'
const PAGE_FILES = ['index.html', 'styles.css', 'assets']

/** The pin and the daemon's lock must name the same Arti: the recipe is what the release watcher reads. */
async function checkPin () {
  const manifest = join(CLONE, 'crates', 'arti-client', 'Cargo.toml')
  if (!existsSync(manifest)) throw new Error(`${CLONE} is not an Arti clone (no crates/arti-client/Cargo.toml): run this from out/torsocks/source, as orivon-port build does`)
  const pinned = /^version = "([^"]+)"/m.exec(await readFile(manifest, 'utf8'))?.[1]
  const locked = lockVersion(await readFile(join(APP_DIR, 'daemon', 'Cargo.lock'), 'utf8'), 'arti-client')
  if (pinned !== locked) {
    throw new Error(`the recipe pins Arti's arti-client ${String(pinned)}, the daemon's Cargo.lock has ${locked}: move both together (README.md section Updating Arti)`)
  }
  return locked
}

function cargo (rust, args, env, cwd) {
  console.log(`cargo ${args.join(' ')}`)
  const result = spawnSync(rust.cargo, args, { cwd, env, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`cargo ${args[0]} failed`)
}

/** Holds RUST_ROOT for this build; another build running there at the same time is refused by name. */
async function lockRustRoot () {
  const lock = join(RUST_ROOT, 'build.lock')
  const holder = existsSync(lock) ? Number(readFileSync(lock, 'utf8')) : NaN
  if (Number.isInteger(holder) && holder !== process.pid) {
    let alive = false
    try { process.kill(holder, 0); alive = true } catch {}
    if (alive) throw new Error(`another TorSocks build (process ${String(holder)}) is using ${RUST_ROOT}; wait for it to finish`)
  }
  await writeFile(lock, String(process.pid))
  return async () => { await rm(lock, { force: true }) }
}

/** The daemon, from a copy whose lock has the patched crates unpinned, so `--locked` still holds every other crate. */
async function buildDaemon (rust, wasiSdk) {
  const copy = join(RUST_ROOT, 'src')
  await rm(copy, { recursive: true, force: true })
  // A `target/` a person's own cargo run left in daemon/ is not part of the source.
  await cp(join(APP_DIR, 'daemon'), copy, { recursive: true, filter: (path) => !path.split(/[\\/]/).includes('target') })
  const committedLock = await readFile(join(copy, 'Cargo.lock'), 'utf8')
  await writeFile(join(copy, 'Cargo.lock'), unlockPatched(committedLock))
  const patchArgs = await preparePatchedCrates(join(RUST_ROOT, 'patched'), committedLock)
  const env = {
    ...wasiBuildEnv(wasiSdk, [[RUST_ROOT, STAND_IN]]),
    CARGO_HOME: join(RUST_ROOT, 'cargo-home'),
    CARGO_TARGET_DIR: join(RUST_ROOT, 'target'),
    // The rustc found above: cargo would otherwise take the first on PATH, which may be a system one without the target.
    RUSTC: rust.rustc
  }
  cargo(rust, ['build', '--release', '--locked', '--target', RUST_TARGET, ...patchArgs], env, copy)
  const built = join(WORK, `${PROGRAM}.wasm`)
  await cp(join(RUST_ROOT, 'target', RUST_TARGET, 'release', `${PROGRAM}.wasm`), built)
  return built
}

async function bundlePage (toolsDir) {
  const esbuild = createRequire(join(toolsDir, 'package.json'))('esbuild')
  const { orivonShimPlugin } = await loadShimPlugin()
  const result = await esbuild.build({
    entryPoints: [join(APP_DIR, 'page', 'src', 'main.js')],
    outfile: join(OUT, 'app.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    logLevel: 'silent',
    plugins: [orivonShimPlugin()]
  })
  printWarnings(result)
  for (const file of PAGE_FILES) await cp(join(APP_DIR, 'page', file), join(OUT, file), { recursive: true })
}

const mvpRoot = () => process.env.ORIVON_MVP_ROOT ?? resolve(APP_DIR, '..', '..', '..', 'orivon-mvp')

const arti = await checkPin()
const rust = findRust()
ensureRustTarget(rust.rustup)
const toolsDir = join(WORK, 'node-tools')
await mkdir(toolsDir, { recursive: true })
ensureNodeTools(toolsDir)
await mkdir(RUST_ROOT, { recursive: true })
const unlock = await lockRustRoot()
let component
try {
  const wasiSdk = await ensureWasiSdk(join(RUST_ROOT, 'toolchain'))
  console.log(`Rust ${rust.version}, Arti ${arti}, ${wasiSdk}`)
  component = await buildDaemon(rust, wasiSdk)
} finally {
  await unlock()
}
await rm(OUT, { recursive: true, force: true })
await mkdir(join(OUT, 'bin'), { recursive: true })
await transpileComponent({ component, name: PROGRAM, outDir: join(OUT, 'bin'), toolsDir, mvpRoot: mvpRoot() })
await bundlePage(toolsDir)
console.log(`orivon-dist: page, app.js and bin/${PROGRAM}.p2 written`)

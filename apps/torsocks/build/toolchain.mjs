// Every tool TorSocks' build needs, each pinned: Rust with the wasm32-wasip2
// target (found, not installed: rustup is the person's own), the WASI SDK
// that compiles the C inside the daemon (SQLite, ring), checked against the
// digest its release publishes, and the two Node tools that bundle the page
// and transpile the daemon, installed into out/torsocks/ beside the clone.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const RUST_TARGET = 'wasm32-wasip2'
/** Arti's own minimum supported Rust version at the pinned release. */
export const RUST_MINIMUM = [1, 92]

const WASI_SDK_TAG = 'wasi-sdk-34'
const WASI_SDK_VERSION = '34.0'
/** `${process.platform}-${process.arch}` to the release's asset name and its published sha256. */
const WASI_SDK_ASSETS = {
  'linux-x64': ['x86_64-linux', 'b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4'],
  'linux-arm64': ['arm64-linux', 'f7e243dff54d60bcc576e94d6166b69f410f2500ae4a9ceef34315be10e77971'],
  'darwin-x64': ['x86_64-macos', '87d27fa8adc68dee59bfbf2e22a6d34ef717c34d6bf1d8af2a56fc929d9ce0eb'],
  'darwin-arm64': ['arm64-macos', '9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9'],
  'win32-x64': ['x86_64-windows', 'cccb5c323a9b34f0349a9b09e8804a0a7632c68c3310f4b5f437ed57d7e71d8f'],
  'win32-arm64': ['arm64-windows', '45e1c71f3e965621e7b98ebe1d37b0e4b1f77f3e8072113ffb4534e67b1a4b7c']
}

/** esbuild at the version orivon-mvp's shim plugin is built against; jco-transpile at the one its WASI host is tested with. */
export const NODE_TOOLS = { esbuild: '0.25.12', '@bytecodealliance/jco-transpile': '0.15.0' }

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name)

function run (command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32' && !command.endsWith('.exe'), ...options })
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(), error: result.error }
}

/** `rustc 1.99.0 (...)` to `[1, 99]`; undefined when the text is not rustc's. */
export function rustcVersion (text) {
  const match = /^rustc (\d+)\.(\d+)\./.exec(text)
  return match === null ? undefined : [Number(match[1]), Number(match[2])]
}

/**
 * Cargo and rustup from rustup's own directory first (a system cargo earlier
 * on PATH is often older than Arti allows), then from PATH. Throws naming
 * what to install when neither is new enough.
 */
export function findRust (env = process.env) {
  const home = cargoHome(env)
  const candidates = [join(home, 'bin'), '']
  for (const dir of candidates) {
    const tool = (name) => (dir === '' ? name : join(dir, exe(name)))
    if (dir !== '' && !existsSync(tool('cargo'))) continue
    const rustc = run(tool('rustc'), ['--version'])
    const version = rustc.ok ? rustcVersion(rustc.out) : undefined
    if (version === undefined) continue
    if (version[0] < RUST_MINIMUM[0] || (version[0] === RUST_MINIMUM[0] && version[1] < RUST_MINIMUM[1])) continue
    return { cargo: tool('cargo'), rustup: tool('rustup'), version: version.join('.') }
  }
  throw new Error(`TorSocks' daemon needs Rust ${RUST_MINIMUM.join('.')} or newer from rustup (https://rustup.rs), which was not found in ${home} or on PATH`)
}

/** Adds the WebAssembly target to the person's toolchain when it is missing: rustup's own, additive step. */
export function ensureRustTarget (rustup) {
  const installed = run(rustup, ['target', 'list', '--installed'])
  if (!installed.ok) throw new Error(`rustup could not list its targets: ${installed.out || installed.error?.message}`)
  if (installed.out.split(/\s+/).includes(RUST_TARGET)) return
  console.log(`rustup target add ${RUST_TARGET}`)
  const added = run(rustup, ['target', 'add', RUST_TARGET], { stdio: 'inherit' })
  if (!added.ok) throw new Error(`rustup target add ${RUST_TARGET} failed`)
}

async function download (url, file, sha256) {
  const response = await fetch(url)
  if (!response.ok || response.body === null) throw new Error(`${url}: HTTP ${String(response.status)}`)
  const hash = createHash('sha256')
  const partial = `${file}.partial`
  const hashing = new TransformStream({ transform (chunk, controller) { hash.update(chunk); controller.enqueue(chunk) } })
  await pipeline(Readable.fromWeb(response.body.pipeThrough(hashing)), createWriteStream(partial))
  const digest = hash.digest('hex')
  if (digest !== sha256) {
    await rm(partial, { force: true })
    throw new Error(`${url} has sha256 ${digest}, not the pinned ${sha256}`)
  }
  await rename(partial, file)
}

/** Fetches a .tar.gz checked against `sha256` and unpacks it into `dir`. */
export async function fetchArchive (url, sha256, dir) {
  await mkdir(dir, { recursive: true })
  const archive = join(dir, `.download-${sha256.slice(0, 12)}.tar.gz`)
  await download(url, archive, sha256)
  const unpacked = run('tar', ['-xzf', archive, '-C', dir])
  await rm(archive, { force: true })
  if (!unpacked.ok) throw new Error(`tar could not unpack ${url}: ${unpacked.out || unpacked.error?.message}`)
}

/** The WASI SDK's root under `toolsDir`, fetched once per machine and version. */
export async function ensureWasiSdk (toolsDir) {
  const key = `${process.platform}-${process.arch}`
  const asset = WASI_SDK_ASSETS[key]
  if (asset === undefined) throw new Error(`the WASI SDK publishes no build for ${key}`)
  const [suffix, sha256] = asset
  const root = join(toolsDir, `wasi-sdk-${WASI_SDK_VERSION}-${suffix}`)
  if (existsSync(join(root, 'bin', exe('clang')))) return root
  const name = `wasi-sdk-${WASI_SDK_VERSION}-${suffix}.tar.gz`
  console.log(`fetching ${name}`)
  await fetchArchive(`https://github.com/WebAssembly/wasi-sdk/releases/download/${WASI_SDK_TAG}/${name}`, sha256, toolsDir)
  if (!existsSync(join(root, 'bin', exe('clang')))) throw new Error(`${name} did not unpack to ${root}`)
  return root
}

/**
 * SQLite's defaults for Arti's directory cache, the database's only user. Every file call of a
 * program in Orivon is a round trip to its broker: exclusive locking skips the hot-journal check
 * and header re-read SQLite makes before each statement, a 64 MB page cache reads each page once,
 * 16 KB pages make a quarter of the calls, and no fsync (a cache Arti rebuilds) makes a commit a
 * few writes. README.md section Design notes.
 */
export const SQLITE_FLAGS = [
  '-DSQLITE_DEFAULT_LOCKING_MODE=1',
  '-DSQLITE_DEFAULT_PAGE_SIZE=16384',
  '-DSQLITE_DEFAULT_CACHE_SIZE=-65536',
  '-DSQLITE_DEFAULT_SYNCHRONOUS=0',
  '-DSQLITE_TEMP_STORE=3'
]

/** Cargo's own directory, where crates.io sources are unpacked. */
export function cargoHome (env = process.env) {
  return env.CARGO_HOME ?? join(homedir(), '.cargo')
}

/**
 * The environment that points cc-rs at the WASI SDK and lets tokio build its sockets for WASI.
 * `remaps` are `[directory, stand-in]` pairs: every path under a directory is written into the
 * program as the stand-in, so the build is the same bytes wherever it runs and names no one's
 * home directory. Rust's flags go encoded, so a path with a space stays one argument.
 */
export function wasiBuildEnv (wasiSdk, remaps = [], env = process.env) {
  const target = RUST_TARGET.replaceAll('-', '_')
  const { RUSTFLAGS: _ignored, ...rest } = env
  return {
    ...rest,
    [`CC_${target}`]: join(wasiSdk, 'bin', exe('clang')),
    [`AR_${target}`]: join(wasiSdk, 'bin', exe('llvm-ar')),
    // cc-rs splits CFLAGS at spaces, so a directory with one in it is left to the Rust remap alone.
    [`CFLAGS_${target}`]: [`--sysroot=${join(wasiSdk, 'share', 'wasi-sysroot')}`, ...remaps.filter(([from]) => !/\s/.test(from)).map(([from, to]) => `-ffile-prefix-map=${from}=${to}`)].join(' '),
    // tokio offers its net feature on WebAssembly only under the cfg.
    CARGO_ENCODED_RUSTFLAGS: ['--cfg', 'tokio_unstable', ...remaps.map(([from, to]) => `--remap-path-prefix=${from}=${to}`)].join('\x1f'),
    LIBSQLITE3_FLAGS: SQLITE_FLAGS.join(' ')
  }
}

function installedVersion (toolsDir, name) {
  try {
    return JSON.parse(readFileSync(join(toolsDir, 'node_modules', name, 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

/** esbuild and jco-transpile at their pinned versions, in `toolsDir/node_modules`. */
export function ensureNodeTools (toolsDir) {
  const missing = Object.entries(NODE_TOOLS).filter(([name, version]) => installedVersion(toolsDir, name) !== version)
  if (missing.length === 0) return
  const specs = missing.map(([name, version]) => `${name}@${version}`)
  console.log(`npm install ${specs.join(' ')}`)
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const installed = run(npm, ['install', '--prefix', toolsDir, '--no-save', '--no-audit', '--no-fund', '--ignore-scripts=false', ...specs], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (!installed.ok) throw new Error(`npm could not install ${specs.join(' ')}`)
}

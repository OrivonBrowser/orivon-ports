// The one Arti crate the daemon builds changed, and how. Each change is a
// literal replacement that must match exactly as often as written, so a new
// Arti release that moves the line fails the build by name instead of
// building something else; README.md section Design notes says why each is
// needed and what would let it go.
//
// The crate is downloaded from crates.io and checked against the checksum in
// the daemon's Cargo.lock, then Cargo is pointed at the copy with a
// `[patch]`. The lock the build uses differs from the committed one only in
// the patched entries, which lose the registry source and checksum a path
// crate cannot have.

import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { fetchArchive } from './toolchain.mjs'

export const CRATE_PATCHES = [
  {
    crate: 'tor-persist',
    version: '0.47.0',
    edits: [
      // tor-persist leaves its file-backed state out of every wasm32 build, while arti-client
      // uses it everywhere but wasm32-unknown-unknown; WASI has files, so the gate is narrowed
      // to arti-client's.
      {
        file: 'src/lib.rs',
        from: '#[cfg(not(target_arch = "wasm32"))]\n',
        to: '#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]\n',
        count: 2
      },
      // An onion service's state directory is "touched" when it starts; Orivon's files have no
      // times to set, so on WASI an unsupported touch is let pass. Storing state renames a file
      // into the directory, which moves its time all the same.
      {
        file: 'src/state_dir.rs',
        from: '    filetime::set_file_mtime(dir, mtime)\n        .map_err(|source| Error::new(source, Action::Initializing, resource()))\n',
        to: '    match filetime::set_file_mtime(dir, mtime) {\n' +
          '        #[cfg(target_os = "wasi")]\n' +
          '        Err(e) if e.kind() == std::io::ErrorKind::Unsupported || e.raw_os_error() == Some(58) => Ok(()),\n' +
          '        other => other.map_err(|source| Error::new(source, Action::Initializing, resource())),\n' +
          '    }\n',
        count: 1
      }
    ]
  }
]

const REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index'

/** `text` with each edit made, after checking it matches exactly `count` times. */
export function applyEdits (text, edits, where = 'the file') {
  let out = text
  for (const edit of edits) {
    const found = out.split(edit.from).length - 1
    if (found !== edit.count) {
      throw new Error(`${where}: expected ${String(edit.count)} of ${JSON.stringify(edit.from)}, found ${String(found)}; the pinned Arti changed this line, so the patch in build/crates.mjs needs a look`)
    }
    out = out.split(edit.from).join(edit.to)
  }
  return out
}

/** The `[[package]]` block of `name` `version` in a Cargo.lock, or undefined. */
function lockBlock (lock, name, version) {
  return lock.split('\n[[package]]\n').find((block) => block.startsWith(`name = "${name}"\nversion = "${version}"\n`))
}

/** The checksum Cargo.lock holds for a registry crate. */
export function lockChecksum (lock, name, version) {
  const block = lockBlock(lock, name, version)
  if (block === undefined) throw new Error(`Cargo.lock has no ${name} ${version}`)
  const match = /\nchecksum = "([0-9a-f]{64})"\n/.exec(`${block}\n`)
  if (match === null || !block.includes(`\nsource = "${REGISTRY}"\n`)) throw new Error(`Cargo.lock's ${name} ${version} is not from crates.io`)
  return match[1]
}

/** The version Cargo.lock resolved `name` to, when there is exactly one. */
export function lockVersion (lock, name) {
  const versions = [...lock.matchAll(new RegExp(`\\n\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([^"]+)"`, 'g'))].map((m) => m[1])
  if (versions.length !== 1) throw new Error(`Cargo.lock holds ${String(versions.length)} versions of ${name}`)
  return versions[0]
}

/** Cargo.lock as Cargo resolves it with the patched crates in place: their source and checksum lines removed. */
export function unlockPatched (lock, patches = CRATE_PATCHES) {
  let out = lock
  for (const { crate, version } of patches) {
    const checksum = lockChecksum(out, crate, version)
    const registered = `name = "${crate}"\nversion = "${version}"\nsource = "${REGISTRY}"\nchecksum = "${checksum}"\n`
    out = applyEdits(out, [{ from: registered, to: `name = "${crate}"\nversion = "${version}"\n`, count: 1 }], 'Cargo.lock')
  }
  return out
}

/**
 * Downloads each patched crate, checked against the committed lock, into
 * `dir`, makes its edits, and returns Cargo's `--config` arguments for them.
 */
export async function preparePatchedCrates (dir, committedLock, patches = CRATE_PATCHES) {
  const args = []
  for (const { crate, version, edits } of patches) {
    const sha256 = lockChecksum(committedLock, crate, version)
    const root = join(dir, `${crate}-${version}`)
    await rm(root, { recursive: true, force: true })
    await fetchArchive(`https://static.crates.io/crates/${crate}/${crate}-${version}.crate`, sha256, dir)
    if (!existsSync(join(root, 'Cargo.toml'))) throw new Error(`${crate}-${version}.crate did not unpack to ${root}`)
    const byFile = Map.groupBy(edits, (edit) => edit.file)
    for (const [file, fileEdits] of byFile) {
      const path = join(root, file)
      await writeFile(path, applyEdits(await readFile(path, 'utf8'), fileEdits, `${crate} ${file}`))
    }
    args.push('--config', `patch.crates-io.${crate}.path=${JSON.stringify(root)}`)
  }
  return args
}

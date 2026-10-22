import { describe, expect, it } from 'vitest'
import { applyEdits, CRATE_PATCHES, lockChecksum, lockVersion, unlockPatched } from '../build/crates.mjs'
import { rustcVersion } from '../build/toolchain.mjs'

const REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index'
const SUM = 'e7a3bc60cbe74bf41cd63e2506a9a16bd52047668771578b12ff2453ec4c7522'
const LOCK = `version = 4

[[package]]
name = "arti-client"
version = "0.47.0"
source = "${REGISTRY}"
checksum = "${'1'.repeat(64)}"

[[package]]
name = "tor-persist"
version = "0.47.0"
source = "${REGISTRY}"
checksum = "${SUM}"
dependencies = [
 "serde",
]
`

describe('applyEdits', () => {
  it('replaces each line exactly as often as written', () => {
    expect(applyEdits('a\nX\nb\nX\n', [{ from: 'X\n', to: 'Y\n', count: 2 }])).toBe('a\nY\nb\nY\n')
  })

  it('fails by name when the pinned source moved the line', () => {
    expect(() => applyEdits('a\nX\n', [{ from: 'X\n', to: 'Y\n', count: 2 }], 'tor-persist src/lib.rs')).toThrow(/tor-persist src\/lib\.rs: expected 2 .* found 1/)
  })

  const editsOf = (file: string) => (CRATE_PATCHES[0]?.edits ?? []).filter((edit) => edit.file === file)

  it('narrows tor-persist\'s wasm32 gate the way its 0.47.0 source is written', () => {
    const gate = '#[cfg(not(target_arch = "wasm32"))]\n'
    const source = `mod err;\n${gate}mod fs;\n${gate}pub use fs::FsStateMgr;\n`
    const patched = applyEdits(source, editsOf('src/lib.rs'))
    expect(patched).not.toContain(gate)
    expect(patched.split('target_os = "unknown"').length - 1).toBe(2)
  })

  it('lets an unsupported touch of a state directory pass, on WASI only', () => {
    const source = 'fn touch() {\n    filetime::set_file_mtime(dir, mtime)\n        .map_err(|source| Error::new(source, Action::Initializing, resource()))\n}\n'
    const patched = applyEdits(source, editsOf('src/state_dir.rs'))
    expect(patched).toContain('#[cfg(target_os = "wasi")]')
    expect(patched).toContain('ErrorKind::Unsupported')
    expect(patched).toContain('other => other.map_err(|source| Error::new(source, Action::Initializing, resource())),')
  })
})

describe('the lock the build uses', () => {
  it('reads a crate\'s resolved version and checksum', () => {
    expect(lockVersion(LOCK, 'arti-client')).toBe('0.47.0')
    expect(lockChecksum(LOCK, 'tor-persist', '0.47.0')).toBe(SUM)
    expect(() => lockChecksum(LOCK, 'tor-persist', '0.46.0')).toThrow(/no tor-persist 0\.46\.0/)
  })

  it('unpins only the patched crate', () => {
    const unlocked = unlockPatched(LOCK)
    expect(unlocked).toContain('name = "tor-persist"\nversion = "0.47.0"\ndependencies = [')
    expect(unlocked).not.toContain(SUM)
    expect(unlocked).toContain(`checksum = "${'1'.repeat(64)}"`)
  })
})

describe('rustcVersion', () => {
  it('reads rustc\'s own words', () => {
    expect(rustcVersion('rustc 1.99.0 (b940084d7 2026-09-28)')).toEqual([1, 99])
    expect(rustcVersion('cargo 1.99.0')).toBeUndefined()
  })
})

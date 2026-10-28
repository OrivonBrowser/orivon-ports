# Upstream: Arti

| | |
|---|---|
| Source | `https://gitlab.torproject.org/tpo/core/arti` |
| Pinned commit | `ce8bc6e0998bd5a4efdf06dd62dce53c98ea1087` (arti-v2.7.0; its crates are 0.47.0) |
| Licence | MIT OR Apache-2.0, used here under MIT |

TorSocks is written in this repository; Arti, the Tor Project's implementation of Tor in Rust, is
the library it is built on (`upstream.library` in [`recipe.json`](recipe.json)). The Tor Project
did not make TorSocks and does not endorse it.

## What crosses into this repository

**Nothing of Arti's.** The clone lives in `out/torsocks/source/` and everything built from it in
`out/torsocks/static/`, both gitignored. The daemon depends on Arti's crates as crates.io publishes
them, at the versions [`daemon/Cargo.lock`](daemon/Cargo.lock) names with their checksums; Cargo
fetches them at build time into its own cache, outside this repository.

What is ours, and written from scratch:

- [`page/`](page/): the page, its interface and its core.
- [`daemon/src/`](daemon/src/): `torsocksd`, a program built on `arti-client`, `tor-hsservice` and
  `tor-socksproto`. Its SOCKS handling follows the shape of Arti's own `arti` proxy (the handshake
  loop and the error-to-reply table), written again here against Arti's public crates.
- [`daemon/fslock-guard-wasi/`](daemon/fslock-guard-wasi/) and
  [`daemon/shellexpand-utf8/`](daemon/shellexpand-utf8/): two small crates with the public API of
  `fslock-guard` and of `shellexpand::path`, put in their place with Cargo's `[patch]`. They hold
  none of those crates' code: README.md section Design notes says why each is needed.
- [`build/`](build/): the build. [`build/crates.mjs`](build/crates.mjs) changes two things in
  `tor-persist` 0.47.0 at build time, in a copy downloaded from crates.io and checked against the
  lock's checksum; the copy stays in `out/`.

## What to re-check when the pin moves

- `daemon/Cargo.toml` pins `arti-client`, `tor-rtcompat`, `tor-hsservice`, `tor-socksproto`,
  `tor-cell` and `tor-proto` with `=`: move them to the release's crate version, run
  `cargo update` in `daemon/`, and check that `build/build.mjs` accepts the pin (it compares the
  clone's `arti-client` version with the lock's).
- `build/crates.mjs`: each replacement asserts how often it matches, so a release that moved or
  fixed the line fails the build by name. When Arti gates `FsStateMgr` on
  `target_os = "unknown"` itself, that edit is deleted; the state-directory touch edit goes when
  Orivon's WASI host can set file times.
- `daemon/fslock-guard-wasi/`: the version must stay semver-compatible with what Arti asks for, and
  the API the same (`lock`, `try_lock`, `delete_lock_file`).
- `daemon/shellexpand-utf8/`: the same for `shellexpand::path::full_with_context` and
  `LookupError`; it can go once `os_str_bytes` builds on stable Rust for `wasm32-wasip2`.
- `daemon/src/onion.rs` `state_word` and `problem_text` word Arti's `State` and `Problem` for the page,
  and `plainProblem` and `settlingLine` in `page/src/ui/helpers.js` word two of those texts ("publishing
  its descriptor", "introduction points") and each state: a release that renames a state, adds one or
  rewords a problem needs both looked at. The page's own tests of a service (`page/src/core/reach.js`)
  do not depend on any of it.
- Arti's minimum Rust version: `RUST_MINIMUM` in `build/toolchain.mjs`.

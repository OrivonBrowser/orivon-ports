# Upstream: typage

| | |
|---|---|
| Source | `https://github.com/FiloSottile/typage` |
| Pinned commit | `38b8b10cb22409de0eaa8a617a01f16dc2e3f9f4` (v0.3.1) |
| Licence | BSD-3-Clause |

Orivon Share is written in this repository; typage (`age-encryption` on npm), by Filippo Valsorda and
the age authors, is the [age](https://age-encryption.org/v1) implementation it encrypts and decrypts
with (`upstream.library` in [`recipe.json`](recipe.json)). The typage project did not make Orivon
Share and does not endorse it.

## What crosses into this repository

**Nothing of typage's.** The clone lives in `out/share/source/` and everything built from it in
`out/share/static/`, both gitignored. The build installs the clone's own locked dependencies
(`@noble/ciphers`, `@noble/curves`, `@noble/hashes`, `@noble/post-quantum`, `@scure/base`, pinned by
typage's `package-lock.json`) with `npm ci`, and bundles typage's `lib/index.ts` from the clone into
`crypto-worker.js`, unminified and with every licence comment kept.

What is ours, and written from scratch:

- [`page/`](page/): the page, its library, its IPFS code (CIDs, CAR files, gateway reads, pinning), the
  kept-share storage, the WebRTC serving (a WebTorrent tracker client, the peer protocol), and the worker
  that calls typage.
- [`build/build.mjs`](build/build.mjs): the build.

The tracker client speaks the WebTorrent tracker protocol over WebSocket as the `bittorrent-tracker`
package documents it; none of that package's code is used or copied, and the public trackers and STUN
servers named in `page/src/serve/` are services the page calls, not software it ships.

## The IPFS node the app ships

The app also ships Orivon's IPFS node in `bin/` (`bin/ipfs-node.p2/`, with its `LICENSE-MIT` and
`LICENSE-APACHE`): a WebAssembly build, transpiled by jco, of
[`OrivonBrowser/orivon-ipfs-node`](https://github.com/OrivonBrowser/orivon-ipfs-node) at commit
`d035ccc`, made by that repository's `orivon-wasm.yml` workflow. It is MIT OR Apache-2.0. The build
fetches the published folder by its CID (`IPFS_NODE` in [`build/build.mjs`](build/build.mjs)) and
checks every block of it; nothing of the node is committed here.

## The relay's dependencies

The circuit relay in [`relay/`](relay/README.md) runs on js-libp2p (`libp2p` and the `@libp2p/*` and
`@chainsafe/libp2p-*` packages, each Apache-2.0 OR MIT). They are installed on the relay's host from
[`relay/package-lock.json`](relay/package-lock.json) with `npm ci`, every version at least two weeks
old when it was locked; none of their code is committed here.

## What to re-check when the pin moves

- The stream API the worker uses: `Encrypter.setPassphrase`, `setScryptWorkFactor`, `encrypt` over a
  `ReadableStream`, `Decrypter.addPassphrase`, `decrypt` over a `ReadableStream`, in `lib/index.ts`.
- The work factor: `Encrypter`'s default `scryptWorkFactor` is 18, and the worker sets it anyway;
  `ScryptIdentity` refuses a file whose factor is above its own limit.
- The message age gives when no passphrase matches: `no identity matched any of the file's recipients`
  (`lib/index.ts`). `page/src/crypto/errors.js` reads it to tell a wrong password from a damaged file.
- The lock file: `npm ci` must still install exactly what the lock names.

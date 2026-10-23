# Fluux Messenger port reconnaissance

Read against **processone/fluux-messenger** at `f900aba2eb56f49bd1a5c379d7f396e285278d17` (release
`v0.18.0`), from a local clone. Line numbers are that revision's.

## There is no Electron build, so the target is the web bundle

Fluux's desktop, iOS and Android apps are Tauri programs: `apps/fluux/src-tauri/` holds a Rust
crate and `apps/fluux/package.json` carries the `tauri*` scripts. No `package.json` in the
repository depends on Electron, so there is no Electron renderer and no preload to keep.
`CLAUDE.md` Rule 8 prefers an Electron renderer whenever one exists; here none does, and the web
bundle is the only build left.

That bundle is what upstream itself ships as `fluux-messenger-<version>-web.zip` and runs at its
live demo. The `build-web` job of `.github/workflows/release.yml` makes it with `npm ci`,
`npm run build:sdk` and `npm run build`, and zips `apps/fluux/dist`. The root `npm run build`
already runs the SDK build first, so this recipe runs `npm ci` and `npm run build`.

Upstream's `README.md` (section "Will there be other installations methods?") says the bundle can
be served by any web server, and `docs/CONNECTION.md` says the web build reaches a server over a
WebSocket (RFC 7395) with no proxy, where the native apps use a Rust TCP proxy.

## The page has no helper to replace

| Question | Answer |
|---|---|
| Preload or `window.<api>` bridge | None in the web build. The Tauri-only code sits behind `platform()` (`apps/fluux/src/platform/index.ts`) and is not reached in a browser |
| Members to declare | 0, so no `bridge/` and no `bridge` field in the recipe |
| `orivon.*` calls in the page | None. Every network call is a Web Platform API |
| Capability ratio | 0 of 0 |

## What the page asks of the platform

| Need | Web API | Where | In Orivon |
|---|---|---|---|
| Talk to the XMPP server | `WebSocket` (xmpp.js, `wss://` or `ws://`) | `packages/fluux-sdk/src/core/modules/Connection.ts` | Routed, `net.https.connect` |
| Find the server's WebSocket address | `fetch` of `/.well-known/host-meta.json` and `host-meta` (XEP-0156) | `packages/fluux-sdk/src/utils/websocketDiscovery.ts:338` | Routed, `net.https.connect` |
| Upload an attachment (XEP-0363) | `XMLHttpRequest` `PUT`, with `xhr.upload.onprogress` | `apps/fluux/src/hooks/useFileUpload.ts:322` | Routed, `net.https.connect` |
| Read an encrypted attachment (XEP-0454) | `fetch` of the ciphertext, then Web Crypto AES-GCM | `apps/fluux/src/utils/mediaCache.ts:463` | Routed, `net.https.connect` |
| Save an attachment | an `<a download>` on a `blob:` URL | `apps/fluux/src/utils/download.ts:42` | Orivon's download handler |
| Avatars, previews, images | `<img>`, `fetch` for animated avatars | `apps/fluux/src/components/Avatar.tsx:227` | Granted https hosts |
| Keep state | IndexedDB, `localStorage`, the Cache API (`caches.open`) | `apps/fluux/src/utils/mediaCache.ts:325` | Page platform |
| End-to-end encryption (OpenPGP) | `openpgp` 6 (Web Crypto, WebAssembly for Argon2id) | `apps/fluux/package.json:68` | Orivon's CSP allows `'wasm-unsafe-eval'` |
| Offline shell, web push | a service worker, `./sw.js` | `apps/fluux/src/utils/serviceWorkerUpdate.ts:157` | Page platform |

## The attachment path is the reason this port is worth checking

Upstream issue 1203 and the README FAQ ("Encrypted attachments don't open or preview in the web
version") say the same thing: in a browser, fetching an attachment's bytes fails when the upload
host sends no CORS headers, because the page's `fetch` is a cross-origin request. Orivon's `fetch`
and `XMLHttpRequest` for a granted host are routed through the main process, which makes the
request itself and returns the answer without a CORS check
(`orivon-mvp/src/preload/routed/README.md`). The port tests this on an upload host that sends no
CORS header at all.

## Build facts

- Node 22.22 or newer (`package.json` `engines`); the release workflow uses Node 24.
- `npm ci` runs `patch-package` over one patch in `patches/` (`@xmpp+sasl-plain+0.14.0.patch`), the
  repository's own, applied to `node_modules` and not to Fluux's source.
- `npm run build` takes about 3.5 minutes under the heavy gate and writes `apps/fluux/dist`
  (about 12 MB, 159 precached entries, `sw.js` and a web app manifest included).
- `vite.config.ts` sets `base: './'`, so every URL in the build is relative. The router is a
  `HashRouter` (`apps/fluux/src/main.tsx:167`), so no server fallback is needed.
- `apps/fluux/index.html` carries **one inline classic script**, a `process.nextTick` shim for the
  SCRAM-SHA-1 dependencies. The shell's CSP has no `'unsafe-inline'`, so `hooks.mjs` moves it to
  `orivon/next-tick-shim.js` byte for byte.

## Verdict

**Cheap.** A recipe, a manifest, one hook and no bridge. The licence is AGPL-3.0-or-later, which
is on the allowlist.

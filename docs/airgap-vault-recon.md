# Port recon: AirGap Vault

**A page with no preload at all.** `orivon-port recon` finds zero `exposeInMainWorld` names and
zero `ipcMain` handlers, and that zero is real: upstream's `electron/` directory is a vestigial
Capacitor 2 wrapper (`nodeIntegration: true`, a generic Capacitor bridge, no named members), and
`src/` imports no `electron` module and no Node builtin. The cost this port carries is not a bridge
— it is that Orivon's permission gate denies the two browser APIs (camera, clipboard read) this app
uses to receive anything to sign, and nothing in a recipe or a bridge can change that.

Measured against `aa50b7f0371ed2e681f358d22b546c7c000e05b7` (`v3.34.4`) on 2026-09-23. Line numbers
are that commit's.

## What the renderer does

| Fact | Evidence |
|---|---|
| Imports no node builtin, no `electron` | `orivon-port recon` over `src`, both counts zero |
| `exposeInMainWorld` bridge names | none — `orivon-port recon` |
| `ipcMain` handlers | none — `orivon-port recon` |
| Routing is history-based, not hash | `app-routing.module.ts:291` — no `useHash`, no `LocationStrategy` override |
| Every runtime request is same-origin | i18n JSON, ~51.5 MB of Sapling parameters, lazily-loaded chunks — no other host is ever fetched |
| Platform detection is Ionic's `platform.is(x)`, not a Capacitor native check | `@ionic/core/utils/platform.js:66-72`; `Capacitor.isNativePlatform()` is never called in `src/` |
| The Chromium default user agent flips a real branch | `platform.is('electron')` is a `/electron/i` match against `navigator.userAgent` (`device.service.ts:126-128`), not a Capacitor plugin — see "What Orivon's window gives it for free" |

## The preload: none

There is nothing to declare. `apps/airgap-vault/` ships no `bridge/` directory and `recipe.json`
carries no `bridge` field — the honest answer to a zero-member preload, not a smaller version of
one. `--preload` (recon's escape hatch for a preload it can't find on its own) has no target to
point at either: `electron/index.js`'s preload is `node_modules/@capacitor/electron/dist/electron-bridge.js`,
third-party code this port never runs.

## The requirement nobody had written down

**On the web platform upstream ships, a secret's entropy is stored in plaintext.**
`secure-storage.factory.ts:14-19` returns `SecureStorageServiceMock` whenever the platform is not
`hybrid`. Its `setItem` (`secure-storage.mock.ts:40-46`) `console.warn`s the value and writes it to
`localStorage` unencrypted; `SecretsService.addOrUpdateSecret` (`secrets.service.ts:155-157`) is
what puts the BIP-39 entropy there. This is upstream's own behaviour on every browser this app
would ever run in outside its packaged mobile and desktop builds — nothing this port does changes
it, and nothing could without editing app code, which would fail the escape test below before it
started. The README states it as what it is: a property of the web platform this app already
shipped, not a defect this port introduced.

**A second, smaller requirement `hooks.mjs` exists to fix.** Upstream's Electron build target sets
`<base href="./">`, which is correct only when the document is loaded from wherever its own bundle
happens to sit (a real Electron app's `file://` load). This port serves the app from its own
origin's root, and the app's own router redirects `''` straight to `/tabs/tab-secrets` at boot — so
a reload or a bookmark of the URL a person is actually looking at resolves every asset under
`/tabs/` and 404s. `hooks.mjs` rewrites the one attribute after the build.

## What Orivon's window gives it for free, and what it can't grant at all

There is no main process to translate into capabilities, but there is a browser surface to check
against what Orivon's permission gate allows every origin
(`orivon-mvp/src/main/sessions/permission-gate.ts`) — the equivalent question, for an app with no
`ipcMain` handlers, to ASGARDEX's 39.

| What the app needs | Orivon's answer | What it costs |
|---|---|---|
| `crypto.subtle`, secure-context APIs | Granted — `127.0.0.1` and a dev `.eth` origin (with the resolver switch) both count as secure contexts | Nothing |
| `clipboard-sanitized-write` | Granted to every origin, no prompt | Nothing — every "copy to clipboard" affordance works |
| WebAssembly compilation, blob workers, inline scripts/styles | Not blocked on the dev-serving path this port runs on (no CSP is set there) | Nothing on this path; the installed/cached path's CSP (`src/loader/serve.ts:195-203`) would need `'wasm-unsafe-eval'` and `worker-src blob:` added, which is outside this repository |
| `getUserMedia` (camera, for QR scan and for camera/microphone entropy) | **Denied to every origin.** No manifest field or capability exists to ask for it | QR scanning cannot work here at all |
| `navigator.clipboard.readText()`/`.read()` | **Denied to every origin**, by design (ADR-0022) | Settings' "Paste from clipboard" — the app's *other* way to receive a sign request — cannot work here either |
| The Chromium default user agent containing `"Electron"` | Not something a manifest, a recipe or a bridge can change | This app's own code reads that string directly and takes its Electron branch, which (harmlessly) shows a one-time disclaimer, and (not harmlessly) leaves the scan tab blank behind a Cordova permission call that always rejects — on top of the camera being refused regardless |

### The escape test

There is no capability-backed member to run it against — the two gaps above are refused before any
app code executes, not after a bridge hands back a value. Nothing here escapes into app code
because nothing here reaches app code at all.

## Verdict

**A target, and the cheapest shape this repository has ported yet — measured in bridge cost.** Zero
members, zero handlers, one HTML rewrite. What replaces "how many members needed a capability" is
"which two browser permissions does this app need that Orivon refuses to every origin, with no
capability that could grant either" — camera and clipboard read, which happen to be AirGap Vault's
only two ways to receive a transaction to sign. Everything else — generating a secret, deriving
accounts across every bundled protocol including the WASM-signed ones, displaying the account-sync
QR code — works. This is recorded as a gap in `orivon-mvp`, not solved here: `docs/porting-guide.md`
is explicit that a missing power is a shell question when no existing capability can honour it, and
this repository does not grow a clipboard or camera shim to route around that.

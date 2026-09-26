# `apps/element/`: Element Desktop as an Orivon app

**What lives here.** A recipe, a manifest, and the bridge that stands in for
`apps/desktop/src/preload.cts` -- Element Desktop's own Electron preload. **No Element source
and no Element build output is in this repository**; see [`UPSTREAM.md`](UPSTREAM.md) for the
pin, the licence, and where the build actually lands.

**This is Element *Desktop*, not a web build.** Element Desktop's renderer is, byte for byte,
the same `apps/web` webpack build the hosted `app.element.io` runs -- desktop's own release
pipeline just packs it into an asar next to a `config.json`. What turns that build into the
*desktop* app, with its own settings screen, its own OAuth flow and its own pickle-key/search
plumbing, is one thing: `window.electron` existing (`apps/web/src/vector/init.tsx` picks
`ElectronPlatform` over `WebPlatform` exactly when it does). `bridge/element.js` is what supplies
it.

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json) | Where upstream is, at which commit, and the exact build desktop's own CI runs |
| [`orivon.json`](orivon.json) | The manifest -- what the consent dialog shows a person |
| [`bridge/members.json`](bridge/members.json) | `window.electron`'s 5 members: 2 refused by name, 3 `hand` |
| [`bridge/element.js`](bridge/element.js) | The 3 hand-written members, and everything they dispatch to -- see [The seam](#the-seam) |
| [`bridge/element.test.ts`](bridge/element.test.ts), [`initialise.test.ts`](bridge/initialise.test.ts), [`pickle-key.test.ts`](bridge/pickle-key.test.ts) | 113 tests: the channel allowlist, every `ipcCall`/`seshat` name, `initialise()`, and the pickle key against Element's own decrypt logic |
| [`UPSTREAM.md`](UPSTREAM.md) | The pin, the licence, what never crosses into this repository |
| [`../../docs/element-recon.md`](../../docs/element-recon.md) | The reconnaissance this port was built from |

## Running it

```bash
orivon-port run element
```

Clones `element-hq/element-web` at the commit `recipe.json` pins, runs its own
`pnpm --dir apps/web build`, prepares `out/element/static`, and serves it on
`http://127.0.0.1:8878`. Open that URL in Orivon and accept the prompt. There is **no `.eth`
name** for this app -- see [Why no `.eth` name](#why-no-eth-name).

## Differs from Element Desktop: where your keys live

**Read this before trusting this port with a real account.**

Real Element Desktop encrypts your "pickle key" -- the key that protects your access token and
your end-to-end encryption store -- with Electron's `safeStorage`, which is backed by your
operating system's keychain (GNOME Keyring, KWallet, macOS Keychain, Windows DPAPI). **This port
cannot do that.** Orivon has no capability today that lets an app reach an OS keyring; ADR-0003
in `orivon-mvp` explicitly reserves `safeStorage` for the browser's own secrets, "no app, ever."

Instead, `bridge/element.js` reproduces **Element Web's own** pickle-key scheme --
`apps/web/src/BasePlatform.ts` and `utils/tokens/pickling.ts` -- exactly: a non-extractable
AES-GCM key held in the same `matrix-react-sdk` IndexedDB database the app already writes to.
This is not a downgrade from what `app.element.io` already does in a normal browser tab -- it is
the same protection level. It is a downgrade from what the real *desktop* app does. Concretely:

- Your access token and crypto store key are only as protected as this origin's browser storage
  (`localStorage`/IndexedDB isolation), not additionally wrapped by an OS-level secret.
- Anything that can read this origin's IndexedDB -- a bug in Orivon's storage isolation, disk
  access to an unencrypted home directory -- can read the key.

**Hand-off to orivon-mvp:** build an app-facing secret-storage capability backed by the OS
keyring (the way `safeStorage` already exists for the browser's own secrets), and reconsider
ADR-0003's "no app, ever" line in that light. Until that lands, this is the honest ceiling for
any E2EE app ported here, not just this one.

## The seam

`window.electron`'s real shape is a **generic forwarder** (`on`/`send` over a fixed 19-channel
allowlist), not named capability members -- see
[`../../docs/element-recon.md`](../../docs/element-recon.md) for why recon's own member count
does not apply here and what the actual, hand-counted surface is. The declared roster:

| Member | Bucket | Reason |
|---|---|---|
| `on`, `send`, `initialise` | `hand` | A decision, or a dispatch on an argument no kit bucket expresses |
| `getSettingValue`, `setSettingValue` | `refused`, `shell-owned` | `initialise()` reports all six `Electron.*` settings unsupported, so neither is ever called |

`send`'s own dispatch answers 36 more names across two nested protocols
(`apps/web/src/vector/platform/IPCManager.ts`'s `{id, name, args}` envelope, which has **no
timeout** -- every one of these has to be answered, never merely ignored):

| Channel | Names answered | What they get |
|---|---|---|
| `ipcCall` | `getAppVersion` | Fetches the build's own `version` file, cached |
| | `getUpdateFeedUrl` | `''` -- no self-update; there is no updater here |
| | `setLanguage`, `breadcrumbs`, `clearStorage`, `callDisplayMediaCallback` | Inert constants |
| | `focusWindow` | `window.focus()` |
| | `navigateBack`, `navigateForward` | `history.back()`/`forward()` |
| | `getSpellCheckEnabled`, `get(Available)SpellCheckLanguages` | `false`/`[]` -- spellcheck is the browser's |
| | `setSpellCheckEnabled`, `setSpellCheckLanguages` | Refused, `shell-owned` |
| | `getDesktopCapturerSources` | `[]` -- legacy screen-share picker; nothing to list |
| | `getPickleKey`, `createPickleKey`, `destroyPickleKey` | The scheme above |
| `seshat` | `supportsEventIndexing`, `isRoomIndexed`, `addHistoricEvents`, `add`/`removeCrawlerCheckpoint` | `false` |
| | `closeEventIndex`, `deleteEventIndex`, `addEventToIndex`, `deleteEvent`, `commitLiveEvents`, `searchEventIndex`, `setUserVersion` | `undefined`, resolved -- **not refused**: `deleteEventIndex` is awaited on every login |
| | `isEventIndexEmpty` | `true` |
| | `getStats`, `getUserVersion` | `0` |
| | `loadFileEvents`, `loadCheckpoints` | `[]` |
| | `initEventIndex` | Refused, `excluded` -- Seshat is a native Rust module (Rule 8) |
| `app_onAction` | `call_state` (`connected`/`ended`) | A `navigator.wakeLock` screen lock, standing in for main's `powerSaveBlocker` |
| `check_updates` | -- | Replies `false` on the same channel: no update feed |

Recognised but never acted on (the browser's own chrome, or a push Element's main process would
send that nothing here triggers): `before-quit` (fired by this bridge itself on `pagehide`),
`install_update`, `loudNotification`, `preferences`, `setBadgeCount`, `update-downloaded`,
`userDownloadCompleted`, `userDownloadAction`, `openDesktopCapturerSourcePicker`,
`userAccessToken`, `homeserverUrl`, `serverSupportedVersions`, `showToast`.

## `initialise()`

The one call `ElectronPlatform` awaits before it renders anything, folding together what
`preload.cts` splits into `getProtocol`/`getConfig`/`getSupportedSettings`, plus two things a
real main process does differently:

1. **A Web Lock**, so a second Element tab on this origin waits rather than sharing a crypto
   store -- `ElectronPlatform.checkSessionLockFree()`/`getSessionLock()` always return `true`,
   which turns off Element Web's own multi-tab lock, on the assumption that Electron never had
   two windows open on one profile.
2. **Registers Element's own `sw.js`** (part of the `apps/web` build output, never edited here)
   and answers its `{type: "userinfo"}` postMessage from `localStorage`. This is what lets
   authenticated media work: real Electron does the equivalent with a `session.webRequest`
   rewrite in main (`apps/desktop/src/media-auth.ts`), which a page cannot install; the service
   worker path is the one a page can.

Then it fetches `orivon/element-config.json` (this port's own copy of `apps/desktop/element.io/
release/config.json`, added by `extraFiles`, never Element's own `config.json` fetch path) and
fills in the three defaults `apps/desktop/src/config.ts` supplies when the file omits them
(`brand`, `help_url`, `web_base_url`).

## Why no `.eth` name

Under `ElectronPlatform`, OIDC login registers as an `application_type: "native"` client, and
Matrix Authentication Service only accepts native redirects to a loopback address --
`127.0.0.1`, `[::1]`, or `localhost`. A `.eth` origin can never be one, so this port keeps its
plain `127.0.0.1:8878` address rather than shipping a name that would break login.

## Blocked on orivon-mvp

Per this repository's Rule 9: these are reported, not worked around here.

1. **No app-facing OS-keyring secret store** -- see "Differs from Element Desktop" above. Needs
   an ADR against ADR-0003's "no app, ever" line.
2. **OIDC login (matrix.org and any other MAS-backed homeserver) cannot complete.**
   `repartitionView` (`orivon-mvp/src/main/shell/tab-view.ts`) builds a new WebContents when a
   tab leaves the app's origin and again when it returns, which wipes the `sessionStorage`
   `persistOAuthSettings.ts` keeps OIDC state in. Password login and legacy SSO (state in
   `localStorage`, in the persistent partition) are unaffected.
3. **Routed-`fetch()` limits Element hits in real use** (`orivon-mvp/src/preload/README.md`):
   FormData bodies are refused, so in-app bug reports (rageshakes) fail outright; the 16 MiB
   response cap can truncate a large account's initial `/sync` or a big attachment; redirects are
   not followed (A116), which affects `.well-known` server discovery on a domain that redirects.
4. **No notifications capability.** The permission gate denies them (A202) while
   `ElectronPlatform` assumes they are always granted.

## Design notes

- **The bridge is a generic forwarder, on purpose, not a set of named members recast as one.**
  `window.electron` genuinely is `on`/`send` over a channel list in upstream's own preload; giving
  it named members here would be inventing an API Element never had.
- **`.wasm` needed a repository-wide fix, not an app-local one**: `src/serve.ts`'s MIME table had
  no entry for it, and `WebAssembly.instantiateStreaming` refuses anything else outright. Fixed
  once, for every port (`src/serve.test.ts` proves it against a real fetch).
- **Seshat's answers are upstream's own "not installed" answers, not refusals**, because refusing
  the ones `Lifecycle.clearStorage()` awaits unconditionally (`deleteEventIndex`, chiefly) would
  break login, not just search. `docs/element-recon.md` has the reasoning.
- **The pickle key matches Element Web's scheme exactly, not a different one Orivon might prefer**,
  because the whole point is letting Element's *own*, unmodified `sw.js` read it back out for
  authenticated media. A bespoke scheme would need forking that file, which this port never does.

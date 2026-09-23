# Element port reconnaissance

Read against **element-hq/element-web** at `2d90d6b7b601ecb9ccdf81239a43b4396b4b0c9e` (release
`v1.12.29`, 2026-09-22), via the GitHub API -- no local clone. Line numbers are that revision's.

## The tool undercounts here, and says why itself

`orivon-port recon` scans `src/preload*` for `.js|.mjs|.cjs|.jsx|.ts|.tsx|.vue|.svelte`. Element
Desktop's preload is `apps/desktop/src/preload.cts` -- a `.cts` file, outside that extension list
-- so a recon pass over a real clone reports zero preload members here. The renderer call sites
also don't live under any of recon's default roots: they're in the monorepo's `apps/web`, not
under `apps/desktop`. Both counts below are hand-read from the source instead.

## The shape: a generic forwarder, not named members

Unlike FreeTube or ASGARDEX, Element Desktop's `window.electron` is **not** a set of named
capability functions. `apps/desktop/src/preload.cts` exposes exactly three real members --
`on(channel, listener)`, `send(channel, ...args)`, `initialise()` -- plus two settings accessors,
over a fixed 19-channel allowlist:

```
app_onAction, before-quit, check_updates, install_update, ipcCall, ipcReply, loudNotification,
preferences, seshat, seshatReply, setBadgeCount, update-downloaded, userDownloadCompleted,
userDownloadAction, openDesktopCapturerSourcePicker, userAccessToken, homeserverUrl,
serverSupportedVersions, showToast
```

Two of those channels, `ipcCall` and `seshat`, carry their *own* nested `{id, name, args}`
protocol (`apps/web/src/vector/platform/IPCManager.ts`), so the real surface is not 5 members but
5 members **plus every name the two dispatchers answer**:

| Source | Names | Kind |
|---|--:|---|
| `apps/desktop/src/ipc.ts` (`ipcCall`) | 18 | settings, spellcheck, pickle key, version, capturer, navigation |
| `apps/desktop/src/seshat.ts` (`seshat`) | 18 | encrypted-room search index |

This is the shape `docs/porting-guide.md`'s recon step calls a generic forwarder: recon's own
`ipcMain.handle/on` call-site count is the right proxy for it, not the preload's member count,
and here that count is 5 (the `window.electron` members) + 36 (the two dispatch tables) = 41
answerable names, not 5.

## Classification

| Bucket | Count | Names |
|---|--:|---|
| `hand` (a decision, or a dispatcher no kit bucket expresses) | 3 | `on`, `send`, `initialise` |
| `refused`, shell-owned | 2 | `getSettingValue`, `setSettingValue` |
| Answered inside `send`'s own dispatch (not separately declared) | 36 | 18 `ipcCall` names + 18 `seshat` names |

**Capability ratio: 0 of 41 answerable names reach for an `orivon.*` capability.** Every answer is
either a constant, a Web Platform API (`fetch`, IndexedDB, Web Locks, Wake Lock, a service
worker), or a refusal. This is the cheap end of the candidates table's "cheap to medium" estimate
for Element -- the medium part was always the two optional natives, both refused by name:

- **Seshat** (encrypted-room search index): a native Rust module (`matrix-seshat`/
  `@matrix-org/seshat`), excluded under Rule 8. `supportsEventIndexing` must still answer `false`
  rather than refuse -- refusing every Seshat call breaks login, because
  `Lifecycle.clearStorage()` unconditionally awaits `deleteEventIndex()`.
- **X.509 / PKCS#11 hardware-key signing**: an optional dependency (`graphene-pk11`/`pkcs11js`),
  present only on `develop`, not in the pinned release. Not built.

## Why `on`/`send`/`initialise` are all `hand`, not a kit bucket

- The kit's `listeners` bucket records one callback per member name and never fires it -- `on`
  needs to key on its first *argument* (the channel), hold several listeners per channel, and
  actually fire them, none of which that bucket does.
- No bucket dispatches on an argument, which is what `send` has to do for the `ipcCall`/`seshat`
  channels.
- `initialise` needs a fetch, a Web Lock and `crypto.randomUUID()` -- outside what
  `asyncConstants` can express.

## What crossed into the design that recon alone would not have found

- `apps/web/src/vector/platform/ElectronPlatform.tsx`'s `IPCManager` has **no timeout** on a
  pending call, so every `ipcCall`/`seshat` name has to be answered, never merely ignored.
- `apps/web/src/BasePlatform.ts` and `utils/tokens/pickling.ts` define the pickle-key scheme the
  bridge reproduces (see `apps/element/README.md`), so that Element's **own** service worker
  (`sw.js`, part of the `apps/web` build output) can decrypt the access token it stores in the
  same IndexedDB database, for authenticated media.
- `ElectronPlatform.checkSessionLockFree()`/`getSessionLock()` always return `true`, turning off
  Element Web's own multi-tab lock -- so the bridge has to enforce single-tab-per-origin itself
  (a Web Lock), or two tabs on one account can corrupt the crypto store.

## Where this leaves the candidates-table entry

Element (row 35) is removed from `docs/port-candidates.md`: it is `apps/element/`, not a
candidate, as of this recon.

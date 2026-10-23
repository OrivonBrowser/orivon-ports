# Fluux Messenger

## About this build

**A community build by Orivon of Fluux Messenger, not the official Fluux Messenger.** Fluux Messenger is an XMPP chat client for communities and teams. This directory holds the recipe that builds it to run in Orivon; the upstream project did not make this build.

| | |
|---|---|
| Official project | [github.com/processone/fluux-messenger](https://github.com/processone/fluux-messenger) |
| Official downloads | <https://github.com/processone/fluux-messenger/releases/latest> |
| Pinned upstream | 0.18.0 (v0.18.0), commit `f900aba2eb56` |
| This build's version | 0.18.0 (upstream 0.18.0; a build number is added when the build is released) |
| Licence | AGPL-3.0-or-later, upstream's own; the licence text is served at `/LICENSE` and the source location at `/SOURCE`, see [`UPSTREAM.md`](UPSTREAM.md) |
| Recipe | [`recipe.json`](recipe.json), [`orivon.json`](orivon.json) |
| In another browser | The app works there. This page adds a small corner notice that can be closed. |
| Updates | When upstream releases a new version, the pin is moved and the build is redone ([maintaining a port](../../.claude/skills/orivon-porting/maintain.md)); there is no schedule. The app's own update checker is left as upstream wrote it. |
| Problems | [Report a problem with this build](https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=Fluux%20Messenger): it goes to this repository's issue form, not to the upstream project's tracker. |

Known gaps in this build:

- **Servers that only speak TCP cannot be reached.** The build is upstream's web bundle, which talks to a server over a WebSocket. Upstream's desktop app also reaches servers on port 5222 or 5223 through a Rust helper that this build does not have, so a server needs a `wss://` endpoint (most public servers publish one).
- **A server on the local network is not reachable unless the manifest names it.** A host typed at run time is reachable only when it is public.
- **Notifications and web push** are denied by Orivon.

The sections below are for people working on the build.

**What lives here.** A recipe, a manifest, one hook and its test. **No Fluux source and no Fluux build output is in this repository**; see [`UPSTREAM.md`](UPSTREAM.md) for the pin, the licence and where the build lands.

**Why the web bundle.** Fluux's desktop app is a Tauri program, so there is no Electron renderer to keep. The bundle is what upstream itself publishes as the `-web.zip` on its releases page, built the way its release workflow builds it. [`../../docs/fluux-recon.md`](../../docs/fluux-recon.md) is the measurement.

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json) | Where upstream is, at which commit, and its own `npm ci` and `npm run build`; the licence copied to `/LICENSE` |
| [`orivon.json`](orivon.json) | The manifest: `net.https.connect` for any public host |
| [`hooks.mjs`](hooks.mjs) | Moves the one inline script out of the built `index.html`, and writes `/SOURCE` (where the source is) into the served tree |
| [`bridge/hooks.test.ts`](bridge/hooks.test.ts) | The hook's tests |
| [`UPSTREAM.md`](UPSTREAM.md) | The pin, the licence, what never crosses into this repository |

## Running it

```bash
orivon-port run fluux
```

Clones `processone/fluux-messenger` at the pinned commit, runs its own `npm ci` and `npm run build` (about four minutes), prepares `out/fluux/static` and serves it on `http://127.0.0.1:8897`. Open that URL in Orivon and accept the prompt. The declared name is `fluux.orivonstack.eth`.

## What the person is asked

The manifest declares one capability, `net.https.connect` for `*:*`, so the question is the network-access one and nothing else. The app keeps its account and its messages in the browser storage of its own origin.

## What it needs from orivon-mvp

Catalogue ids in `test/app-behaviours/catalogue.md` that this port relies on:

- `routed-fetch-reaches-granted-hosts`: the host discovery request, the upload `PUT` (an `XMLHttpRequest`) and the download of an attachment's bytes reach a granted host with no CORS check. A browser refuses these when the upload host sends no CORS headers.
- `blob-download-saves-without-dialog`: a decrypted attachment is saved from a `blob:` link.
- `indexeddb-survives-restart`: the account's messages and keys stay in IndexedDB.
- `service-worker-registers-on-app-origin`: the build registers its own `sw.js`.
- `wildcard-host-never-reaches-loopback`: `*:*` does not reach a server on this computer.

## Design notes

**The inline script.** Upstream's `index.html` carries one inline script that defines `process.nextTick` for its SCRAM-SHA-1 dependency. The shell's policy has no `'unsafe-inline'`, so `hooks.mjs` writes it to `orivon/next-tick-shim.js` unchanged and loads it in the same place. The hook throws when the document no longer has it.

# `apps/airgap-vault/`: upstream AirGap Vault, unmodified, as an Orivon app

**What lives here.** A recipe, a manifest, and one HTML rewrite. **No AirGap Vault source and no
AirGap Vault build output is in this repository** -- see [`UPSTREAM.md`](UPSTREAM.md) for its
licence and where it goes instead.

**What this measures.** AirGap Vault is this repository's third port, and it is a different shape
from both prior ones: it has no preload bridge to rebuild at all. FreeTube and ASGARDEX each carry
a named `contextBridge` API this port stands in for; AirGap Vault's Electron wrapper is a vestigial
Capacitor 2 shim with no named members, so the renderer needs nothing from `orivon.*` beyond
ordinary browser APIs. What it tests is whether the porting method still says something useful when
the answer to "how much does the bridge cost" is zero.

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json) | Where upstream is, at which commit, and how to build it |
| [`orivon.json`](orivon.json) | The manifest -- `capabilities: {}`, so there is nothing to grant |
| [`hooks.mjs`](hooks.mjs) | Rewrites `<base href="./">` to `<base href="/">` after the build |

## Running it

```bash
orivon-port run airgap-vault
```

Then open `http://127.0.0.1:8886` in Orivon -- no consent prompt, because the manifest declares no
capability -- or `airgap-vault.eth` instead, once the shell is launched with `orivon-port names`'
output pointed at (`ORIVON_ETH_NAMES_FILE=.../out/names.json npm run dev`, run from `orivon-mvp` --
the top-level [`README.md`](../../README.md)'s "Opening it by name instead of by port" has the
exact command; it resolves to nothing without this).

No build wrapper. Upstream's own `build:electron:prod` script (`ng build --base-href=./
--configuration production`) is the Electron renderer target this port wants, so the recipe runs it
unmodified. The install uses `npx --yes yarn@1.22.19`, not a bare `yarn`: on a Debian-family
machine `/usr/bin/yarn` is frequently cmdtest's unrelated program of the same name, and upstream
vendors no Yarn release of its own to fall back on the way ASGARDEX does.

## The seam

**Zero.** `recon` finds no `contextBridge.exposeInMainWorld` call and no `ipcMain` handler, because
there is neither to find: upstream's `electron/index.js` loads `@capacitor/electron`'s own generic
preload with `nodeIntegration: true`, a Capacitor-2-era pattern this app has otherwise outgrown --
its renderer targets Capacitor 6, and `src/` imports no `electron` module and no Node builtin. On
web (`Capacitor.getPlatform()` returning `'web'`, which is what this port's origin looks like to
it), every native plugin call already resolves through Capacitor's own web fallbacks or rejects
`UNIMPLEMENTED`, and the app is written to tolerate that: see "What this port does not do".

**One thing this port does supply that is not a bridge member.** Orivon's window carries no
`electron` in its user agent, but Chromium's own default user agent contains the string
`"Electron"`, and the app reads it directly (`platform.is('electron')`, a user-agent match) rather
than through any Capacitor plugin. That one string flips two behaviours: a one-time distribution
disclaimer modal (harmless), and the QR scan tab, which on an "Electron" user agent asks a Cordova
plugin that does not exist for camera permission, gets a rejection, and renders blank instead of
the camera view it would show a genuine browser. Nothing in this port corrects it -- it is a
property of the real Orivon window, not something a recipe field or a hook can reach around, and
changing Orivon's own user agent is outside what a port may do (`docs/porting-guide.md`: never edit
what the app receives beyond its own served tree). See "What this port does not do" for what that
costs.

## What works

Everything that does not need a signed request to arrive from outside the browser:

- Onboarding, including the distribution disclaimer.
- Generating a secret from touch entropy alone (camera and microphone entropy sources disable
  themselves after five seconds with no permission answer; touch never does), or from dice rolls,
  coin flips, or a typed BIP-39 mnemonic.
- Deriving accounts across every bundled protocol, including the ones whose signing runs in
  WebAssembly (Sapling at boot, Polkadot lazily).
- Displaying the account-sync QR code, and every "copy to clipboard" affordance -- Chromium grants
  `clipboard-sanitized-write` to every origin with no prompt.
- A full reload on the app's default route, `/tabs/tab-secrets` -- the reason for `hooks.mjs`.

## What this port does not do

Both gaps are the same shape: AirGap Vault has exactly two ways to receive a request from the
outside world it is meant to sign -- a scanned QR code, or a pasted clipboard payload -- and Orivon
denies both by design, to every origin, with no capability that grants either
(`orivon-mvp/src/main/sessions/permission-gate.ts`). A person can create an account here; nothing
here can hand it a transaction to sign.

- **QR scanning.** `getUserMedia` for `media` is refused outright; on top of that, this app's own
  Electron-user-agent branch (see "The seam") would leave the scan tab blank even if the camera
  permission existed.
- **Paste from clipboard.** `navigator.clipboard.readText()` and `.read()` are refused outright;
  Settings' "Paste from clipboard" button is the app's only other route for the same UR-encoded
  payload a QR code carries.

Neither is a bridge decision this port can make: there is no `orivon.*` capability for a camera or
for clipboard reading, so nothing here is refused by name the way FreeTube's or ASGARDEX's excluded
members are -- the shell's permission gate answers before the page's own code, and script, ever
runs. Raising it is an `orivon-mvp` question, not a port one (`docs/porting-guide.md`'s "where a
missing power goes"); this port's job stops at saying plainly what it cannot do and why.

Two more, both upstream's own web fallback rather than anything this port decided:

- **The in-app "isolated module" installer** fails: its web implementation throws on every method
  that would read or write one.
- **Deep links** never fire: `@capacitor/app`'s `appUrlOpen` listener has nothing to trigger it on
  web, so the interaction-mode setting that would open `airgap-wallet://` is effectively inert here.

## Design notes

**Why `hooks.mjs` rewrites the base href instead of building with a `/` base directly.** Rule 8
says to prioritise the Electron static output over a plain web build, and upstream's
`build:electron:prod` script is that target -- it differs from `build:prod` only in setting
`--base-href=./`, which is right for a `file://`-loaded Electron bundle and wrong for a page served
from its own origin's root. Running the *web* build instead would dodge the rewrite, but it is not
the Electron target CLAUDE.md asks a port to prefer, so the recipe runs the real one and the hook
corrects the one attribute that assumes a `file://` load. The cost, stated once here: `./`-relative
asset paths would have survived being mounted under a URL prefix, and `/`-absolute ones will not --
if this app is ever served from anywhere but its own origin's root, the rewrite has to go.

**Why the manifest declares no capability at all.** AirGap Vault makes no runtime request beyond
its own served tree -- every fetch is same-origin (translations, the ~51.5 MB Sapling parameter
files, lazily-loaded chunks) -- so there is nothing to ask for, and `all-or-nothing` consent with an
empty capability set means no dialog is shown at all. This is **not** a proof that the page cannot
reach the network: the dev-origin path this repository's server runs on keeps a page's plain
`fetch`/`XHR`/`WebSocket`/image/script loading on native Chromium networking regardless of what the
manifest declares (only cross-origin `fetch()` on an *installed* app is routed through a capability
check), and WebRTC is open on every origin regardless of capability grants
(`orivon-mvp/docs/open-questions.md` A41). Stated as what it is: upstream's own code makes no
outbound request, not that Orivon enforces it cannot.

**Why there is no bridge file at all**, rather than one with zero members. `orivon-port new` always
scaffolds `bridge/`, but an empty `members.json` is refused at declaration time, and a recipe's
`bridge` field is optional. Deleting both is the honest answer to zero preload members, not a
smaller version of the file.

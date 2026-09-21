# Porting a third-party Electron app to Orivon

**The deliverable is never a fork.** A port is a recipe, a manifest, a build wrapper, and one
bridge file. The app's own source stays in its own clone, under its own licence, unmodified.

[`apps/freetube/`](../apps/freetube/) is the worked example. Every number on this page is
measured there.

## Why an app needs a bridge at all

A desktop Electron app is two programs: a renderer (a web page) and a main process (privileged).
They meet at a **preload script** — the only code that sees both Node and the page's `window`.
It publishes a hand-written object via `contextBridge.exposeInMainWorld('<name>', api)`, and the
page calls `window.<name>.<member>()`, which forwards over IPC to main.

Orivon takes main's place and grants powers to the page directly. The renderer bundle is kept;
the preload and main are dropped. But the bundle still *references* the names the preload
defined, and calling `undefined` throws.

So a port re-creates the **shape** the preload exposed, backed by `orivon.*` instead of IPC.

**It cannot be shared across apps.** The names are each app's own inventions with no standard
behind them — only that app's source says what `chooseDefaultFolder` was meant to do.

**The seam is a process boundary, not a namespace.** `window.*` is only where it is visible,
because `exposeInMainWorld` is the one place a preload can put things. The test for any symbol
is: *is its definition in the bundle I am loading, or in the code I dropped?*

## Step 0 — triage, before committing to an app

```bash
orivon-port recon ~/git/<app>-src
```

Five minutes, and it is the single question that separates a cheap port from an open-ended one.
What it reads off the preload's `exposeInMainWorld`:

- **Named members, one per distinct call** — countable. Multiply by roughly six lines of code
  each and that is your bridge. FreeTube: 34 called members, 203 lines of code plus 132 of
  comment.
- **A generic forwarder** — `invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args)`.
  One member, and the real surface is invisible from the preload: it is every channel string
  main handles. `recon` says so, and reports main's `ipcMain` handler count as the number to
  budget against instead.

The generic-forwarder shape is the one that can be hundreds. It is also the shape Electron's own
security guidance argues against, so a well-behaved app is usually the cheap one.

## Step 1 — read the recon

`recon` answers one question: **how much of the app is already a web page?**

FreeTube's answers: **zero** node builtins in the renderer, **zero** `electron` imports, one
bridge, 34 called members. A renderer that imports no node and no `electron` gets nothing from
the shell's `src/shim-node/` or `src/shim-electron/` — those families never reach it, and the
whole port is the bridge plus routed `fetch`.

**Note the trap:** the *better* an app follows Electron's security guidance (`contextIsolation`
plus a narrow preload), the *less* its renderer touches `electron` directly, and the more the
port concentrates in the bridge. A clean app is not a cheaper app — it is a differently-shaped
one.

**The counts are a floor, not a total.** Computed keys and `Object.assign` defeat a static read.
`recon` says this on its own output; believe it.

## Step 2 — classify every member into five buckets

FreeTube's 34, as the baseline to expect:

| Bucket | Count | What it means |
|---|:--:|---|
| The browser already does it | 7 | fullscreen, PiP, zoom, wake lock, `navigator.language`. No capability at all |
| Inert | 19 | There is no second process left to sync with. Record the callback, never fire it |
| Refused by name | 5 | Excluded by decision, or shell-owned. Must throw with a reason, never be absent |
| Needs a capability | 2 | `orivon.fs` |
| Needs a capability | 1 | `orivon.web.context` |

**33 of 34 needed no capability Orivon did not already have.** A bridge is large because there
are names to route, not because there are things missing. Expect the same skew: most of a bigger
app is more inert members, which is volume, not difficulty.

**The bucket that actually costs you is none of these** — it is a member with no capability
underneath *and* no honest refusal. One of those blocks a port that 2,000 inert lines would not.
Watch the capability ratio, not the line count.

## The escape test — does the human-required fix stay in the bridge?

Most judgment calls are bridge-local and cheap to express. One class is not. The criterion:

**Does the value escape into app code?**

- **No** — the app passes data in and gets back nothing, or something opaque. The bridge controls
  the whole exchange, so any decision can live inside `window.*`. FreeTube's downloads group is
  twelve lines: `chooseDefaultFolder` returns *nothing* and `writeToDefaultFolder` takes a
  *name*, so the folder handle never crosses into renderer code.
- **Yes** — the app receives a value it then joins, parses, displays or stores. The bridge's
  control ends at `return`; it cannot reach the `path.join` three files later. This is the one
  case that forces app edits, and it breaks the unmodified-bundle property.

The canonical instance: `showOpenDialog` hands the renderer host path strings, while
`orivon.fs.userSelected` returns an opaque handle and never a path. Code written in paths cannot
be translated — it must be re-designed around the handle. **Do not "solve" this by manufacturing
a path-shaped string**; the shape exists to stop paths leaking, and faking one reintroduces
exactly what it prevents, silently, in a file that looks fine.

FreeTube needed zero app edits because its own preload API was already handle-shaped. That is
luck, not design. Check it per app, early — it decides whether the port stays repeatable.

## Step 3 — write the bridge

`orivon-port new <id>` scaffolds one with the five groups already laid out. The conventions, all
load-bearing, all visible in
[`apps/freetube/bridge/ft-electron-bridge.js`](../apps/freetube/bridge/ft-electron-bridge.js):

- **A classic, synchronous script, injected first in `<head>`.** Apps call bridge members at
  module top level, so it must already exist when the bundle's first line runs. Not a module: it
  has nothing to import, and it must not be deferred.
- **Refuse by name, never by absence.** A member Orivon cannot honour throws a named error with
  a machine-readable reason (`excluded`, `shell-owned`, `not-built`). An absent member produces
  `undefined is not a function` at a call site that explains nothing.
- **Group members into small factories**, one per reason-for-existing, each with a header saying
  why the group is answered the way it is.
- **Each app stands alone.** Reproduce a pattern from a sibling port rather than importing it.
- **The comments are the deliverable.** 132 of FreeTube's 365 bridge lines are comment, and that
  is correct: a generator can emit `isWaylandPlatform: () => false`, but only a person can write
  down that the app's own `DefinePlugin` compiles `process.platform` to `undefined`, so the guard
  around the one call site never fires.

## Step 4 — the build wrapper, and the two traps that cost the most

A port compiles the app's **Electron renderer** target, not its web target — the web target is
usually the crippled one (upstream FreeTube strips its Local API for the web build precisely
because a browser cannot reach YouTube directly). Wrap the app's own config; never fork it.

Both of these were found by running the build and driving the result in a real window. Neither
is visible by reading source, and both fail without a useful error:

1. **An `IS_ELECTRON` flag can change what the app *fetches at runtime*, not just what it
   compiles.** FreeTube's i18n switches to `${locale}.json.br` under Electron, because upstream's
   own Electron config builds its locale plugin with `compress: true`. Reusing the web config
   with the flag flipped gives you the Electron code path against web assets: every locale 404s,
   the renderer never mounts, and there are **zero console errors** because the failing dispatch
   is never awaited. Patch the already-built plugin instance rather than forking the config.
2. **A `CopyWebpackPlugin` pattern with an absolute `to:` ignores `output.path`.** Changing the
   output directory moves nothing that was written with `path.join(__dirname, '../dist/web/...')`.
   Two consequences: assets 404 in your build, and **the build writes into another target's
   `dist/`**. Rewrite every pattern whose `to:` starts with the old prefix onto your own output
   path.

**Guard every patch with an assertion.** Each one in
[`apps/freetube/webpack.orivon.config.cjs`](../apps/freetube/webpack.orivon.config.cjs) counts
what it patched and throws if the count is wrong, so upstream restructuring its config fails
loudly instead of silently producing a different app.

**The general lesson: run it, drive it, look at the window.** Both traps produced a blank page or
a silent 404, not a stack trace.

## Step 5 — manifest, host, and consent

The app is served by a **plain static file server** reading files off disk. Preparing it is three
additions and nothing else: `/.well-known/orivon.json`, a `<link rel="orivon-manifest">` in the
entry document, and the bridge `<script>`.

**Grants attach to the URL, not to an install** — consent is per-origin, read once on visit,
before any of the app's code runs. The manifest is what the consent dialog renders, so every
capability the bridge will reach for must be declared there and must read honestly to a person.

This is also why each app owns a port: one origin per app, because two apps on one origin would
share a grant.

## Step 6 — test the bridge, and the app

- **Unit-test every member**, including the inert and refused ones, against a fake
  `window`/`document`/`navigator`/`fetch`/`orivon`. Load the bridge's source into a fresh
  `node:vm` context per test — it is a classic script with nothing to import. The scaffold
  starts you there.
- `orivon-port test <app>`, and `npm test` runs it too.
- **End-to-end, assert the thing the app is for.** Metadata loading is not playback.

## When to stop — an app that is not a target

A bridge pushing the 500-line limit is not a file problem. It is the app saying it is deeply an
Electron *program* rather than a web frontend over a narrow helper. The honest answer then is
"not a target", not "write the lines". Say so, with the member count and the capability ratio as
the evidence.

## What is deliberately not built

**A bridge generator.** It is a real idea, and it pays back at app #3, which is also where the
claim that app #3 costs dramatically less than app #1 gets measured. With one port completed it
is tooling for a sample of one.

What such a generator could and could not do, so the question does not get re-opened from
scratch: it **can** emit the member list, arity and a refuse-by-name stub from the preload AST
cross-checked against renderer call sites — `orivon-port recon` already does the reading half.
It **cannot** decide semantics: the preload is only a forwarder, and the behaviour lives in
arbitrary main-process Node that would have to be translated into a deliberately *smaller*
capability set. And it cannot be trusted to bind capabilities unattended: its input is the app's
own code, which is the untrusted party, so inferring a binding from it automates away the exact
step a person is there to perform.

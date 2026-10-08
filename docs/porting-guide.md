# Porting a third-party Electron app to Orivon

**The deliverable is never a fork.** A port is a recipe, a manifest, a build wrapper, a member
declaration, and the few bridge members that carry a decision. The app's own source stays in its
own clone, under its own licence, unmodified.

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

- **Named members, one per distinct call** — countable. Roughly three lines of declaration each,
  plus whatever the few capability-backed ones need in code. FreeTube: 34 called members, 86
  lines of declaration and 167 lines of hand-written members — and 32 of the 34 are in the
  declaration.
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

## Step 2 — classify every member

FreeTube's 34, as the baseline to expect:

| Bucket | Count | What it means | Declared as |
|---|:--:|---|---|
| The browser already does it | 7 | fullscreen, PiP, zoom, wake lock, `navigator.language` | `behaviours`, `constants` |
| Inert | 19 | There is no second process left to sync with. Record the callback, never fire it | `listeners`, `noop`, `asyncConstants`, `behaviours` |
| Refused by name | 5 | Excluded by decision, or shell-owned. Must throw with a reason, never be absent | `refused` |
| Needs a capability | 2 | `orivon.fs` | `behaviours` |
| Needs a capability | 1 | `orivon.web.context` | `hand` |

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
  the whole exchange, so any decision can live inside `window.*`. FreeTube's downloads are two
  declared lines over the kit's `pickedFolderDownloads`: `chooseDefaultFolder` returns *nothing*
  and `writeToDefaultFolder` takes a *name*, so the folder handle never crosses into renderer
  code.
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

## Step 3 — declare the members, write the few that decide something

`orivon-port new <id>` scaffolds a declaration and a members file.
`orivon-port recon <clone> --emit <id>` fills the declaration with every member it found, all
under `unclassified` — and the build refuses while any name is still there, because bucketing is
step 2's judgment and nothing can do it for you.

A member whose answer is a name plus a reason goes in
[`apps/<id>/bridge/members.json`](../apps/freetube/bridge/members.json). The kit generates it,
and the `why` you write becomes the comment above it.
[`src/bridge/README.md`](../src/bridge/README.md) is the format, including apps that expose more
than one global.

A member whose answer lives in code goes in the app's own file, as `function appMembers (kit)`.
[`apps/freetube/bridge/ft-electron.js`](../apps/freetube/bridge/ft-electron.js) has the two that
qualify there, out of 34.

The conventions, all load-bearing:

- **A classic, synchronous script, injected first in `<head>`.** Apps call bridge members at
  module top level, so the bridge must already exist when the bundle's first line runs. The
  composer produces exactly that, which is also why the app's file is spliced rather than
  imported: it has no `import` to reach for.
- **Refuse by name, never by absence.** A member Orivon cannot honour throws a named error with
  a machine-readable reason (`excluded`, `shell-owned`, `not-built`). An absent member produces
  `undefined is not a function` at a call site that explains nothing.
- **Every bucket carries a `why`, and it is required.** A generator can emit
  `isWaylandPlatform: () => false`, but only a person can write down that the app's own
  `DefinePlugin` compiles `process.platform` to `undefined`, so the guard around the one call
  site never fires. The comments are the deliverable; the declaration is where you write them.
- **Each app stands alone in what it decides.** The mechanism is shared — `src/bridge/` — and
  every decision about this app is in this app's declaration. Reproduce a sibling port's
  *reasoning*, never import its members.

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
   Take the name and refuse the compression: see "The output has to survive a host that does
   nothing" below.
2. **A `CopyWebpackPlugin` pattern with an absolute `to:` ignores `output.path`.** Changing the
   output directory moves nothing that was written with `path.join(__dirname, '../dist/web/...')`.
   Two consequences: assets 404 in your build, and **the build writes into another target's
   `dist/`**. Rewrite every pattern whose `to:` starts with the old prefix onto your own output
   path.

**Use the kit, and both traps are closed for you.**
[`src/build/webpack-kit.cjs`](../src/build/webpack-kit.cjs) gives a wrapper four calls:
`requireFromClone` (resolve upstream's own plugins from the clone, or every `instanceof` is
silently false), `patchPlugins` (patch and count, throwing when upstream's config changed shape),
`retargetOutput` (send the build to its own directory **and** move the copy patterns that ignore
`output.path`, refusing to build if any still writes elsewhere), and `addBrowserFallbacks`.
[`apps/freetube/webpack.orivon.config.cjs`](../apps/freetube/webpack.orivon.config.cjs) is the
worked example.

**The general lesson: run it, drive it, look at the window.** Both traps produced a blank page or
a silent 404, not a stack trace.

### The output has to survive a host that does nothing

The development server in this repository is not the only host a port runs on, and it is written
to be the weakest one: it returns the bytes on disk under a `Content-Type` guessed from the name,
and nothing else. An IPFS gateway, an object store or a CDN does the same. So a build may not
emit a file whose *delivery* needs a decision, because on those hosts there is nobody to make it.

In practice that means **pre-compressed assets**. Brotli, gzip or zstd bytes parse only when the
response carries the matching `Content-Encoding`, which a static host cannot derive from a file
it is merely handing back. An app that fetches `${locale}.json.br` is asking for a *name*, not
for compression: emit that name over plain bytes and it works everywhere, because `Response.json()`
and `<script>` alike ignore the extension. Take the name, drop the compression.

`prepare` enforces this ([`src/portable.ts`](../src/portable.ts)): it refuses an output holding
compressed bytes, decoding to decide rather than trusting the extension, so a `.br` file full of
plain JSON passes and a `.js` file full of gzip does not. The failure it prevents is the
expensive kind — a blank page on the host, long after the tests here went green.

The other asymmetry is **routing**: this server answers an extensionless path that has no file
with the entry document, and no gateway does. Hash routing (FreeTube's) never reaches that
branch. A history-routed app does, and must ship a `_redirects` file with `/* /index.html 200`,
which Kubo honours on subdomain and DNSLink gateways but not on path gateways.

## Native addons, child processes and daemons

Orivon runs none of these as machine code; each becomes WebAssembly or a Web Worker under the
app's own grants (orivon-mvp's ADR-0040). What a port ships for each, as Orivon builds them today:

- **A native addon** loads as its WebAssembly build, looked for beside the `.node` path the app
  requires: `<file>.node.wasm`, `<file>.wasm` (emnapi) or `<file>.wasm32-wasi.wasm` (napi-rs). Build
  it for `wasm32-wasip1`: a threaded build (`wasm32-wasip1-threads`) and one exporting `_start`
  refuse by name. Its file calls work only in a forked child of an app whose manifest sets
  `crossOriginIsolated: true`, and an addon over 8 MB loads on the page only after
  `preloadAddon(path)`. orivon-mvp's `src/shim/addon/README.md` has the rest. A napi-rs
  package that publishes a `-wasm32-wasi` build needs none of this: npm installs that build as an
  optional dependency, a bundler that takes the `browser` field picks that build's own loader, and
  it runs, threads included, once the manifest sets `crossOriginIsolated: true`.
- **`spawn`** runs a `wasm32-wasip1` program at the command's path, or with `.wasm` added; it reaches
  files, not sockets. A program that needs the network is built for `wasm32-wasip2` and shipped as
  jco's transpiled output under `<program>.p2/`: spawning the raw component prints the exact `jco
  transpile` command, and the output must be made with it. A tokio program runs on its
  current-thread runtime, built with `RUSTFLAGS="--cfg tokio_unstable"`: tokio refuses its `net`
  feature on WebAssembly otherwise. Its own name resolution (`lookup_host`, or `TcpStream::connect`
  given a name) needs a thread and traps, so resolve with `std::net::ToSocketAddrs` and connect by
  address; the grant is still checked against the name. A native binary refuses as `ENOEXEC`.
  A program has one thread: one that starts threads runs once its port makes it single-threaded.
  Every file call is a round trip to Orivon's broker, so a program that makes a dozen per
  operation is slow here: one that uses SQLite opens its database with the `unix-none` VFS and
  `PRAGMA locking_mode = EXCLUSIVE` when it is the database's only user. orivon-mvp's
  `src/shim/wasi-p2/README.md` has the rest.
- **`fork`** imports the app's own module from its served path into a Worker with the Node shim.
  In an app whose manifest sets `crossOriginIsolated: true`, every synchronous `fs` call and
  `spawnSync`, `execSync` and `execFileSync` work in it; the page itself keeps `readFileSync` and
  `existsSync` alone. A forked child can `spawn` a program of its own.
- **`worker_threads.Worker`** runs an app module as a thread in a Web Worker, with `parentPort`,
  `workerData` and message ports; a thread started from a thread refuses.
- **A child lives until the app's last page closes**, not until the tab that started it does: a
  daemon one tab spawned keeps serving the app's other tabs.
- **A daemon's sockets** need grants like any other: `tcp.connect` patterns for what it dials, and
  `tcp.listen.network` for what it listens on, since Orivon's broker checks only the network grant
  for a listen and binds every interface. A listen is IPv4 whatever family the socket has, so a
  daemon told to listen on `localhost` binds one port twice and collides with itself: give it
  `127.0.0.1`. The page reaches its daemon over `net.connect` to `127.0.0.1`, which needs its own
  `tcp.connect` pattern. A `*:*` pattern never reaches a reserved port such as 53: a daemon
  with its own DNS resolver names that resolver's address and port.

Every file these add is in the served tree, so `prepare` declares it with the rest.

## Node server apps

An app whose upstream is a Node server with a web client, not an Electron program (`apps/the-lounge/`
is the worked example, and [`docs/the-lounge-recon.md`](the-lounge-recon.md) the reading), has no
preload to bridge. Its server runs unmodified in a Worker of the Orivon app, and the app's page shows
what that server serves:

- **Bundle the server's sources with esbuild, not its compiled output.** A compiler turns
  `` import(`./dir/${name}`) `` into `require(name)`, which no bundler follows; esbuild on the
  TypeScript resolves the whole directory. Use `platform: 'node'`, since a `browser` build swaps
  in transports that throw or change, and add orivon-mvp's plugin (`orivonShimPlugin()`, found through
  `ORIVON_MVP_ROOT`) so every Node builtin resolves to the shim. A builtin the shim lacks fails the
  build naming the importer: that list is what orivon-mvp still has to build, so do not stub one here.
- **Make the bundle's gates throw.** Any `require` left in the output that is not on a declared, commented
  list, and any module the server loads by a computed name that is missing from the metafile, fail the
  build. Prove each one fails on a real violation before committing it.
- **The server reads its install tree with `fs`.** Copy what it reads (a client build, defaults) into
  the built tree with a stamp and a file list, and have the page write it into the app's files under the
  virtual root before forking. Give each upstream module its own `__dirname` under that root from a small
  esbuild `onLoad`, so upstream's relative paths land there.
- **A recipe with no `site/` has its page in `apps/<id>/launcher/`**, which `scripts/app-files.ts`
  admits as hand-written `.html`, `.css`, `.js`, `.svg` and their unit tests. The build's `also` step emits
  the launcher into the output directory, so `entry` names it and the executor needs nothing new.
- **The manifest** sets `crossOriginIsolated: true` (a Worker's synchronous `fs` needs it), lists the
  listen port under `net.tcp.listen.local`, the shown origin as `http://*.localhost:<port>` under
  `web.embed.origins`, and whatever the server dials under `net.tcp.connect` and `net.https.connect`.
  A wildcard host is declarable only as `*:*`, so a server that dials arbitrary hosts on chosen ports
  declares every port.
- **The page** forks the bundled server with `child_process.fork`, waits for the server's own readiness
  line, treats `EADDRINUSE` as "another tab of this app already runs it" (a child outlives the tab that
  forked it and ends with the app's last page), runs the server's own CLI for anything a person configures,
  and shows the result in a `<webview>` attached on `about:blank` and then given `loadURL`.
- **What does not carry over:** anything that spawns a native program, listens below port 1024 or on
  the network, or has to stay up when Orivon is closed.

## Step 5 — manifest, host, and consent

The app is served by a **plain static file server** reading files off disk. Preparing it adds
three things to what the app's build emitted: `.well-known/orivon.json`, a
`<link rel="orivon-manifest">` in the entry document, and the bridge `<script>`. Both injected URLs
are written relative to the entry document, so the tree survives being mounted under a prefix;
check that the app's own build does the same before calling a port portable.

Then `prepare` **declares the finished tree**. It writes the served manifest's `assets` list,
every file in the tree but the manifest and the entry, and `.well-known/orivon-ddoc.json`, the
bundle hash Orivon recomputes over what it fetched. Both are generated: never write `assets` into
`apps/<app>/orivon.json`, which `check:manifest` refuses. A file name Orivon refuses on every
platform (a Windows device name, a trailing dot or space, two names differing only in case) fails
`prepare` with the name and the rule it broke; rename it in the build output.
`orivon-port hash <dir> --check` confirms a tree still matches its declaration, and
`orivon-port hash <dir>` redeclares one that was changed on purpose.

**Grants attach to the URL, not to an install** — consent is per-origin, read once on visit,
before any of the app's code runs. The manifest is what the consent dialog renders, so every
capability the bridge will reach for must be declared there and must read honestly to a person.

This is also why each app owns a port: one origin per app, because two apps on one origin would
share a grant.

`apps/<app>/orivon.json` also names the app's `domain` and carries its `version`; the rules, and
the build number to raise on every republish, are in `docs/recipe-format.md` §The manifest's
`domain` and `version`.

## Step 6 — test the bridge, and the app

- **Unit-test every member**, including the inert and refused ones.
  [`src/testing/bridge-harness.ts`](../src/testing/bridge-harness.ts)'s `bridgeSourceFor` +
  `runBridge` give you the composed bridge — the bytes the browser is served — in a fresh
  `node:vm` realm per test, against a fake `window`/`document`/`navigator`/`fetch`/`orivon`. The
  kit's own behaviours are covered once in `src/bridge/`, so what a port's test file owns is its
  roster and its hand-written members.
- `orivon-port test <app>`, and `npm test` runs it too.
- **End-to-end, assert the thing the app is for.** Metadata loading is not playback.

## Step 7 — check what the port relies on against what orivon-mvp keeps proven

`orivon-mvp` keeps a catalogue of the behaviours a working app counts on, each tied to a test its CI
runs: `test/app-behaviours/catalogue.md` in that repository, with a README beside it
(`test/app-behaviours/README.md`) that says when a row and a spec are required. A port that relies on a
behaviour nobody proved can stop working the day an unrelated change lands there, and nothing says so.

1. **List the behaviours this port relies on**, one line each, stated generically and observably:
   "data the app writes to IndexedDB survives a restart", not "settings persist". Draw on the
   manifest's capabilities, the README's "What it needs from orivon-mvp" and "What this port does
   not do", the recon notes and the bridge roster.
2. **Look each one up in the catalogue.** A row that is proven needs its id named in the port's
   README, under "What it needs from orivon-mvp", so a break there is recognised as this port's,
   and this port named in the row's Ports column, so a change to the row names it for a recheck.
3. **For a behaviour with no row, or a row marked `not covered`, hand mvp a prompt** (Rule 9 of
   [`CLAUDE.md`](../CLAUDE.md)): the behaviour in one generic sentence, the line of this port that
   relies on it, and the ask: a row and a spec that does not name this app and copies none of its
   code. Never write the fix here; a session that also works in orivon-mvp writes the row and
   spec there, under that repository's rules.
4. **Do it again when the pin moves.** A new upstream release can rely on a behaviour nothing
   proves yet.

[`.claude/skills/orivon-porting/mvp-tests.md`](../.claude/skills/orivon-porting/mvp-tests.md) is
this step as a decision table, with the prompt's shape.

## When to stop — an app that is not a target

A bridge pushing the 500-line limit is not a file problem. It is the app saying it is deeply an
Electron *program* rather than a web frontend over a narrow helper. The honest answer then is
"not a target", not "write the lines". Say so, with the member count and the capability ratio as
the evidence.

## What is deliberately not built

**A generator that reads the app and decides.** `orivon-port recon --emit` writes the member
*names* into `unclassified`, and generation happens from a declaration a person wrote. Nothing
infers a bucket, and nothing binds a capability on its own. Both limits are structural rather
than a matter of effort:

- **Semantics cannot be read off a preload.** The preload is a forwarder; the behaviour lives in
  arbitrary main-process Node that would have to be translated into a deliberately *smaller*
  capability set. Only the app's own source says what `chooseDefaultFolder` was for.
- **The input is the untrusted party.** Inferring a capability binding from the app's own code
  automates away the exact step a person is there to perform.

So the kit generates the mechanism and refuses to guess the meaning: a member left in
`unclassified` fails the build, and one whose `why` is missing fails it too.

# TiddlyWiki (Node.js server)

## About this build

**A community build by Orivon of TiddlyWiki's Node.js server, not the official TiddlyWiki.** TiddlyWiki is a non-linear personal notebook; its Node.js server keeps every tiddler as a file in a wiki folder and serves the wiki to a browser. This directory holds the recipe that builds it to run in Orivon; the upstream project did not make this build. The wiki folder is in the app's own files, so a wiki saved here survives reloading the tab and restarting Orivon.

| | |
|---|---|
| Official project | [github.com/TiddlyWiki/TiddlyWiki5](https://github.com/TiddlyWiki/TiddlyWiki5) |
| Official downloads | <https://tiddlywiki.com/#GettingStarted> |
| Pinned upstream | 5.4.1, commit `d391595836e2` |
| This build's version | 5.4.1 (upstream 5.4.1, no build number yet) |
| Licence | BSD-3-Clause, upstream's own, served at `/LICENSE`; see [`UPSTREAM.md`](UPSTREAM.md) |
| Status | Early access |
| Recipe | [`recipe.json`](recipe.json), [`orivon.json`](orivon.json) |
| In another browser | This page shows a landing instead of the app, because the app runs a server inside Orivon that another browser cannot. |
| Updates | When upstream releases a new version, the pin is moved and the build is redone ([maintaining a port](../../.claude/skills/orivon-porting/maintain.md)); there is no schedule. |
| Problems | [Report a problem with this build](https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=TiddlyWiki): it goes to this repository's issue form, not to the upstream project's tracker. |

Known gaps in this build:

- **Plugins beyond the server edition's** (`tiddlyweb`, `filesystem`, `highlight`) are not in the app's files, and the wiki folder's `tiddlywiki.info` cannot be edited from the app. A plugin installed from inside the wiki (a plugin library, drag and drop) is a tiddler, so it is saved with the wiki.
- **Interface languages other than English** are not in the app's files.
- **Saving a copy of the wiki as a file** (a download, "save snapshot", an export) is not available: Orivon does not keep files a shown page downloads, and says so in a notice.
- **The command line** (`--build`, `--render`, `--load` and the other commands) is not reachable; the launcher runs `--init server` once and `--listen` after.
- **The server stops with the app's last page**, so the wiki is not served while Orivon is closed, and nothing else on the computer can use it then.
- **The first start writes about twelve hundred files** into the app's files, paced to the platform's rate limit, which took 16 seconds on a busy computer. Making the wiki and every start of the server then read those files back one synchronous call at a time, and each took about a minute there.

The sections below are for people working on the build.

**What lives here.** TiddlyWiki's Node.js server (`tiddlywiki <wikifolder> --listen`) as an Orivon app: a recipe, a manifest, the build that collects the files its boot kernel reads, a small server entry, and the launcher page. **No TiddlyWiki source and no build output is in this repository**: see [`UPSTREAM.md`](UPSTREAM.md) for its licence and pin. The recon is [`docs/wikifolder-recon.md`](../../docs/wikifolder-recon.md).

## Running it

```bash
orivon-port run wikifolder
```

Then open `http://127.0.0.1:8879` in Orivon and accept the prompt, or `wikifolder.orivonstack.eth` with the names file (the repository [`README.md`](../../README.md), Opening it by name).

## What the launcher does

[`launcher/`](launcher/) is the page the app opens. Its decisions are pure functions in `launcher/plan.js`, with tests; `launcher.js` is the DOM, the fork and the files. It:

1. fetches `install/install.json` and `install/pack.bin`, and writes the pack into the app's files under `wikifolder-install/<stamp>/`, unless a tree with that stamp is already there;
2. makes the wiki folder `wikifolder-wiki/` with upstream's own `--init server` when it holds no `tiddlywiki.info`;
3. forks `server.mjs` (upstream's `tiddlywiki <wikifolder> --listen host=127.0.0.1 port=8777`) and waits for upstream's own "Serving on" line;
4. shows `http://wiki.localhost:8777/` in a full-size `<webview>`.

A collapsible log panel shows the server's output. When the server exits, the page says with which code and offers a Restart button. If another tab of this app already started the server, this tab finds the port held, stops its own copy and shows the running one: a child outlives the tab that forked it and ends with the app's last page.

**Where data lives.** In the app's own files, never in the served tree: `wikifolder-wiki/` is the wiki folder (`tiddlywiki.info`, `tiddlers/*.tid`, plugins, themes) and `wikifolder-install/<stamp>/` is the tree the launcher wrote for the server to read. Clearing the app's storage removes both.

## What it is granted, and why

[`orivon.json`](orivon.json) is what the consent dialog renders. `consentGranularity` is `all-or-nothing`: the server cannot start without any one of these. The prompt reads, in Orivon's words:

- "Accept connections from other programs on this device on port 8777"
- "Store files in a private folder for this app on this device"
- "Show pages it serves itself from this computer (port 8777) inside itself, and read and change what those pages show"

| Grant | Value | Why |
|---|---|---|
| `crossOriginIsolated` | `true` | The server runs in a Worker, and its synchronous `fs` calls need a cross-origin isolated app |
| `net.tcp.listen.local` | `8777` | The server's own listener, on `127.0.0.1` only. Not 8080, upstream's default, which many programs hold |
| `web.embed.origins` | `http://*.localhost:8777` | The `<webview>` may show a page only from a listener this app holds on that port |
| `fs.quotaBytes` | 512 MiB | The wiki folder (attachments are files) and the install tree |

No outgoing network is granted: the server dials nothing.

## Design notes

**TiddlyWiki's boot kernel is not bundled; it is loaded from the app's files.** `tiddlywiki.js` is 13 lines. The kernel finds its core, its plugins and its editions as directories beside itself (`boot/boot.js:2435-2437`), and loads every module of a plugin by compiling its text. Bundling it would hide those directories from it. The build copies exactly the directories the shipped editions need into one pack (`install/pack.bin`, an index in `install/install.json`), the launcher writes them under the app's files, and `bridge/server-entry.js` requires `boot/boot.js` from there with the shim's `createRequire`, so `module.filename` is a real path. Not one character of upstream's text is changed.

**The tree is what the two shipped editions name.** `--init server` copies `editions/server`, whose `tiddlywiki.info` lists the plugins and themes a wiki loads. Nothing in the app edits that file, so a plugin directory no edition names would be written and never read. The build derives the list from the editions' own `tiddlywiki.info` (`editionDirs` in `bridge/install-plan.js`), and fails when a required file is missing from the result.

**One pack, because the bundle declaration has a ceiling.** A bundle is limited to 4096 files, and the whole upstream tree is about 3800 before the app's own files. The pack is one file and an index, so the served tree stays small, and the launcher cuts it up by the sizes the index gives; it refuses a pack whose length is not their sum.

**The writes are paced.** The broker admits an origin 100 control calls a second after a burst of 200, and a refused call is asked again for about five seconds. A dozen writers starve one another past that, so the launcher spaces the tree's calls at 80 a second (`createPacer`) instead of relying on the retry.

**Two `vm` calls are answered by a stand-in.** The kernel makes one `vm` context at load and runs each module in it (`boot/boot.js:629`, `:621`) so that a module's stray global assignment is reported. A context of its own needs a second JavaScript realm; the shim refuses `createContext` and `runInContext` by name. `bridge/vm-stand-in.js` is applied to the shim's `vm` object in the Worker before the kernel loads: `createContext` returns the object, and `runInContext` compiles the text in the Worker's own realm. The kernel's check reads `Object.keys(__temp__)` and would report the realm's own globals for every module, so the stand-in gives the code a parameter of that name that is an empty object. The kernel's own `require` hands any module `fs` and `http`, so the sandbox was a tidiness check, not isolation, and nothing is lost. The build reads `boot/boot.js` and fails when it calls another `vm` member or stops reading `__temp__` (`kernelProblems`).

**Port 8777, `127.0.0.1` only.** Upstream's default is 8080. The server answers anything that reaches the port, as upstream does; a write needs the `X-Requested-With: TiddlyWiki` header a page on another site cannot send (`core-server/server/server.js:277`).

## What it needs from orivon-mvp

Catalogue rows (`../orivon-mvp/test/app-behaviours/catalogue.md`) the port relies on:

- `fork-runs-module-in-worker`, `forked-child-ends-with-last-page`
- `local-listener-accepts-connections`, `second-listener-gets-eaddrinuse`
- `webview-shows-local-pattern`, `webview-popup-reaches-the-app`
- `node-fs-writes-land-at-app-root`, `app-files-survive-restart`, `fs-confined-to-app-root`, `fs-quota-refuses-past-limit`

Also, with no catalogue row yet:

- the directories above the app's files root (`/` and `/orivon`) answer `stat` as directories, so a program that creates a folder by checking each ancestor in turn (the server does, for the wiki folder, on `--init` and on each save) gets past them; writes there stay refused;
- a forked child loads CommonJS files from the app's files with `createRequire(<directory>/)`, each with its real `module.filename`, and compiles module text with `new Function` and indirect `eval` under the served CSP;
- the shim's `vm` object accepts assignment of `createContext` and `runInContext` in the child;
- the page writes about twelve hundred files through `fs/promises` at 80 calls a second without a `limit` refusal.

At build time, an esbuild plugin at `$ORIVON_MVP_ROOT/src/shim/bundler/esbuild-plugin.ts` exporting `orivonShimPlugin()` and `virtualRoot`.

# The wiki server port reconnaissance

Read against a local clone of **TiddlyWiki/TiddlyWiki5** at `d391595836e2aead565480763f9bf9eb52e29e75`
(v5.4.1, BSD-3-Clause). Line numbers are that revision's. `orivon-port recon` does not apply: there
is no Electron preload. The wiki server is a Node program that loads its own modules from the
directories it ships in, so this note replaces the recon step's member count with what the server
needs from its host.

## The shape: a kernel and its directories, not a preload

| Fact | Evidence |
|---|---|
| No runtime dependency | `package.json:26` (`devDependencies` only: eslint and its plugins), no `dependencies` key |
| The command-line launcher is 13 lines | `tiddlywiki.js:7-13`: `require("./boot/boot.js").TiddlyWiki()`, `$tw.boot.argv = process.argv.slice(2)`, `$tw.boot.boot()` |
| The kernel finds the core and the servers beside itself | `boot/boot.js:2435-2437` (`bootPath` is `path.dirname(module.filename)`; `corePath` is `../core`; `coreServerPath` is `../core-server`) |
| Plugins, themes, languages and editions are directories beside the core | `boot/boot.js:2410-2413` (`../plugins/`, `../themes/`, `../languages/`, `../editions/`), `:2284-2286` (`loadPlugins`) |
| The first argument that does not start with `--` is the wiki folder | `boot/boot.js:2451-2455` |
| A wiki is the folder with a `tiddlywiki.info` | `core-server/commands/init.js:25` refuses a folder that already has one or is not empty |
| `--init server` copies an edition into the folder | `core-server/commands/init.js:38` (`$tw.utils.copyDirectory`), `editions/server/tiddlywiki.info` lists `tiddlyweb`, `filesystem` and `highlight` |
| `--listen` starts an HTTP server on `127.0.0.1:8080` by default | `core-server/server/server.js:177-181` (`defaultVariables`), `:350-390` (`listen`, "Serving on"), `core-server/commands/listen.js:25-35` |
| A write needs a header a cross-site page cannot send | `core-server/server/server.js:277-278` (`X-Requested-With: TiddlyWiki`), `:49` (`csrf-disable`) |
| Saving is the filesystem plugin writing `.tid` files | `plugins/tiddlywiki/filesystem/filesystemadaptor.js`, `core-server/filesystem.js` |
| The browser side saves by `PUT` to the server | `plugins/tiddlywiki/tiddlyweb/tiddlywebadaptor.js` |

The page a visitor sees is rendered by the server from the loaded core, so the client needs no port
work: it talks to its own origin. The port is the server's host.

## What the server does that a page cannot

| Behaviour | Evidence | This port |
|---|---|---|
| Reads its core, plugins, themes, languages and editions with `fs` | `boot/boot.js:2358-2364` (`loadTiddlersNode`: the boot tiddlers, the core, the server half of the core, the plugins) | The launcher writes the directories into the app's files |
| Loads every module of a plugin by compiling its text | `boot/boot.js:598-627` (`evalGlobal`), `:633-639` (`evalSandboxed`) | The shim's `vm.runInThisContext` and `compileFunction` run it, under the served CSP's `unsafe-eval` |
| Makes a `vm` context at load, and runs each module in it | `boot/boot.js:629` (`vm.createContext({})`), `:621` (`vm.runInContext`) | The shim refuses both by name (a context of its own needs a second realm); `bridge/vm-stand-in.js` answers them in the Worker's own realm |
| Checks each module for stray globals through `Object.keys(__temp__)` | `boot/boot.js:583-593` (`globalCheck`), `:610` (appended when a sandbox is given) | The stand-in gives the code an empty `__temp__`, so the check reports nothing instead of the realm's own globals |
| Reads `../package.json` for the version it checks | `boot/boot.js:2458` | `package.json` is in the install tree |
| Listens with `http.createServer` | `core-server/server/server.js:378-390` (`createServer`, `listen`) | A `net.Server` on loopback, under `tcp.listen.local` |
| Writes the wiki folder with synchronous `fs` | `core-server/filesystem.js`, `core-server/commands/init.js:49` | Needs a cross-origin isolated app |
| Compresses responses when asked to | `core-server/server/server.js:165-168` (`zlib.gzipSync`, off by default: `gzip: "no"`) | The shim's `zlib` is gzip and deflate |
| Hashes with `md5` for its ETags | `core-server/server/server.js:120` | The shim's `crypto` |

## The host has to give

The kernel and the server graph name these Node builtins: `fs`, `path`, `vm`, `http`, `https`,
`url`, `querystring`, `crypto`, `zlib`, `util`, `os`, `stream`, `string_decoder`. Beyond builtins:
`http.createServer` on a loopback `net.Server`, synchronous `fs` in a Worker, and a CommonJS loader
that loads a file by absolute path from the app's files and gives it a real `module.filename`.

## Verdict

**A port, at the cost of the host and not of the server.** The tree on disk is never edited, and
there are no bridge members and no `require` forwarder. The whole seam is where the kernel's
directories live (the app's files), the two `vm` calls the shim refuses (answered by a stand-in the
build guards), and one launcher page. TiddlyWiki is not an always-on server here: it lives as long
as the app's last page.

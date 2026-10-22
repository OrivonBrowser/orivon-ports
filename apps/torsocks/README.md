# TorSocks

## About this app

**TorSocks runs Tor inside Orivon.** It is written in this repository, on Arti, the Tor Project's
Tor implementation in Rust, compiled to WebAssembly. It does two things while a TorSocks tab is
open:

- **A Tor proxy on this computer**: a SOCKS5 address (`127.0.0.1:9150` unless that port is taken)
  that Orivon's "Your proxy" tunnel, or any other program, can use, `.onion` addresses included.
- **Onion services for what you publish**: an article written in the page, a picture, files, a
  folder, or a website folder, each at a `.onion` address of its own that stays the same across
  restarts.

| | |
|---|---|
| Built on | [Arti](https://gitlab.torproject.org/tpo/core/arti) 2.7.0 (crates 0.47.0), commit `ce8bc6e09989`; TorSocks is not made or endorsed by the Tor Project |
| Version | 0.1.0 |
| Licence | This repository's; Arti is MIT OR Apache-2.0, see [`UPSTREAM.md`](UPSTREAM.md) |
| Recipe | [`recipe.json`](recipe.json), [`orivon.json`](orivon.json) |
| Name | `torsocks.eth` |
| In another browser | A landing instead of the app: it needs Orivon's sockets and files. |
| Problems | [Report a problem](https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=TorSocks) |

Known gaps:

- **The proxy and the services run while a TorSocks tab is open**, since an app's programs end
  with its last page in Orivon. Visitors cannot reach a service while TorSocks is closed.
- **TorSocks must stay out of the tunnel it provides.** A person who sends all of Orivon's traffic
  through "Your proxy" sets TorSocks' own tunnel to Off; otherwise TorSocks would try to reach Tor
  through itself. The page says so.
- **No bridges or pluggable transports** (obfs4, Snowflake): a network that blocks Tor blocks
  TorSocks.
- **No client authorization** for onion services, and no proof-of-work defence against
  introduction floods yet (Arti's `hs-pow-full` needs threads, which WebAssembly here lacks).

The sections below are for people working on the app.

## Running it

It needs Rust 1.92 or newer from [rustup](https://rustup.rs), and a checkout of **orivon-mvp**
beside this repository (or `ORIVON_MVP_ROOT`), because the page is bundled with Orivon's Node shim
and the daemon is transpiled for its WASI 0.2 host:

```bash
node src/cli.ts run torsocks
```

The first build fetches the WASI SDK (checked against its published digest), esbuild and
jco-transpile into `out/torsocks/`, adds the `wasm32-wasip2` target to rustup if it is missing, and
compiles Arti; later builds reuse all of it. The app is served at `http://127.0.0.1:8894`. Open it
in Orivon and accept the prompt.

[`page/preview.html`](page/preview.html), served by any static server, shows the interface over a
mock of the core (`page/src/ui/mock.js`; `?phase=failed`, `starting` or `outside-orivon`); the build
does not ship it.

To use the proxy in Orivon: Settings, Tunnels, paste the address into "SOCKS5 address" under "Your
proxy"; then choose "Your proxy" from the tunnel button of a `.onion` site, or send everything
through it.

## What it is granted, and why

| Grant | Why |
|---|---|
| `net.tcp.connect` `*:*` | Tor relays listen on any public address and port. A wildcard never reaches this computer, a private network or a reserved port |
| `net.tcp.connect` `127.0.0.1:9159` | The page reaches the daemon's control port |
| `net.tcp.listen.local` `9150-9159` | The SOCKS5 proxy (the first free of 9150-9158) and the control port (9159), reachable only from this computer |
| `net.concurrentSockets` 512 | Relays, the proxy's clients and the control connections together; a browser routed through the proxy opens many |
| `fs.quotaBytes` 8 GB | Arti's state and directory cache (tens of MB), and what is published (2 GB a publication at most) |

`consentGranularity` is `all-or-nothing`: TorSocks does nothing useful with part of it.

## How it is built

[`build/build.mjs`](build/build.mjs) runs in the Arti clone and writes `orivon-dist/`:

- `bin/torsocksd.p2/`: [`daemon/`](daemon/), built with `cargo build --release --locked --target
  wasm32-wasip2`, then transpiled by jco-transpile with the options orivon-mvp's `spawn` checks
  for, which are read from that checkout ([`build/transpile.mjs`](build/transpile.mjs)).
- `app.js`: [`page/src/main.js`](page/src/main.js) bundled with orivon-mvp's shim plugin, for
  `child_process.spawn`.
- `index.html`, `styles.css`, `assets/`: the page, copied.

The build stops by name when the recipe's pin and the daemon's `Cargo.lock` name different Arti
releases, when a pinned download's digest differs, and when a patched line of Arti moved.

## The daemon

`torsocksd --data /torsocks --socks-port 9150-9158 --control-port 9159 [--publish <id>,...]`

The page spawns it as a WASI 0.2 command (Orivon runs it in a Worker of the app, under the app's
grants). `/torsocks` is the app's own `torsocks/` directory:

| Path | What |
|---|---|
| `control.key` | 64 hex characters the page makes once; the control port's password |
| `services.json` | The page's registry: each publication's id, kind, title, date, size, address and whether it is on |
| `sites/<id>/www/` | What service `<id>` serves |
| `sites/<id>/site.json` | `{ "kind", "listing" }`: whether a directory without `index.html` is listed |
| `arti/state/`, `arti/cache/` | Arti's: guards, keys (one per service, so its address is kept), the directory cache |

**The control port** speaks JSON lines on `127.0.0.1:9159`. The first line must be
`{"op":"hello","key":"<control.key>"}`; anything else is answered `{"t":"refused"}` and closed. A
welcome (`{"t":"welcome","running":[ids]}`) is followed by the latest event of each kind, the recent
log, then every event as it happens. Commands: `publish`, `stop`, `forget` (stop and delete the key,
so the address is gone) and `check` (reach the service through Tor), each with an `id`; `status`;
`quit`.

**Events**, also printed on stdout: `hello` (versions), `bootstrap` (`frac`, `ready`, `msg`,
`blocked`), `bootstrap-error`, `socks` (`listening` with `host` and `port`, or `failed` with
`msg`), `traffic` (`open`, `total`), `service` (`id`, `state`, `onion`, `problem`), `hits` (`id`,
`count`), `check` (`id`, `ok`, `status` or `msg`, `ms`), `forgotten`, `log` (`level`, `target`,
`msg`), `error`, `fatal` (`code`, `msg`), `exit`.

**The SOCKS5 proxy** takes SOCKS4, 4a and 5, CONNECT and RESOLVE. Each user name and password pair
gets circuits of its own, as Tor's `IsolateSOCKSAuth` does; Orivon signs in with a name per site
and app, so they never share an exit.

**An onion service** answers on port 80 with a small HTTP/1.1 server: GET and HEAD, one byte range
per request, `index.html` for a directory, `404.html` when the site has one, and a listing for a
folder. Nothing it sends names the host: no `Date`, no `Server`, no file times.

## What it needs from orivon-mvp

The rows of orivon-mvp's `test/app-behaviours/catalogue.md` TorSocks relies on; a red `[app:<id>]`
test there is a TorSocks breakage:

- `wasi-component-dials-and-serves`: the daemon, a WASI 0.2 component the page spawns, dials Tor
  relays and listens for the proxy and the control port.
- `onion-site-through-own-proxy`: Orivon's "Your proxy" tunnel hands a `.onion` name to the SOCKS5
  server unresolved.
- `local-listener-accepts-connections`: other programs (Orivon's tunnel, a person's own tools)
  reach the proxy on `127.0.0.1`.
- `tcp-connect-to-granted-loopback-port`: the page reaches the daemon's control port.
- `wildcard-host-never-reaches-loopback`: `*:*` is what reaches the relays, and only them.
- `atomic-write-by-rename`, `app-files-survive-restart`: the registry and every service's key
  outlive a restart, so an address is kept.
- `fs-quota-refuses-past-limit`: a publication larger than what is left fails whole.

Measured against the real shell when this was written, and not a catalogue row: Orivon's WASI 0.2
host answers `set-times` as unsupported (Design notes, the `tor-persist` patch), and every file call
a program makes is a broker round trip (Design notes, SQLite).

## Design notes

**Why a daemon written here, and not Arti's own `arti` program.** `arti` is the obvious unit to
port, but its proxy is reachable as a library only behind `experimental-api`, and the program
brings in what WASI has no answer for: file watching, signals, a multi-threaded runtime, process
hardening. `torsocksd` uses Arti's stable public crates instead, `arti-client` for the client and
the services, `tor-socksproto` for the SOCKS handshake, so a new Arti release changes this
program only where Arti's public API changes.

**Why WebAssembly, and WASI 0.2 rather than the browser target.** Orivon runs no native code an app
ships (orivon-mvp's ADR-0040): a program runs as WebAssembly under the app's own grants. WASI 0.2
gives Arti what it expects from an operating system, clocks, randomness, files and sockets, so
Arti's own code runs as it does natively; the browser target would need a socket gateway and a
port of Arti's storage.

**Why one thread.** WASI 0.2 here has no threads, so the daemon runs tokio's current-thread
runtime. Arti needs threads only for onion-service proof of work (`hs-pow-full`), which is left out.

**Why two stand-in crates** ([`daemon/fslock-guard-wasi/`](daemon/fslock-guard-wasi/),
[`daemon/shellexpand-utf8/`](daemon/shellexpand-utf8/)). WASI has no file locks: the real
`fslock-guard` builds there but every lock fails, and Arti stops at its state directory. TorSocks
runs one daemon per app, and the control port refuses a second before it touches the state, so a
lock that always succeeds is safe. `shellexpand` reads paths through `os_str_bytes` 6, which uses a
module stable Rust does not offer on `wasm32-wasip2`; Arti calls exactly one function of it, which
the stand-in provides for UTF-8 paths, all TorSocks uses.

**Why `tor-persist` is patched at build time.** Two things in `tor-persist` 0.47.0 are changed, in a
copy checked against the lock's checksum, and each change asserts the line is there as written
([`build/crates.mjs`](build/crates.mjs)). It leaves its file-backed state manager out of every
`wasm32` build, while `arti-client` uses it on every target but `wasm32-unknown-unknown`: the two
gates disagree on WASI, where files exist, so the build narrows `tor-persist`'s to `arti-client`'s.
And an onion service's state directory is "touched" when the service starts, which Orivon's WASI
host refuses as unsupported because `orivon.fs` sets no file times: on WASI that refusal is let
pass, and the directory's time still moves each time state is stored, by the rename that stores
it. The first change upstream would remove its half of the patch; the second goes when Orivon can
set file times.

**Why SQLite is built and opened differently.** Arti keeps its directory cache in SQLite, and every
file call a program makes in Orivon is a round trip to the broker, about a millisecond. With SQLite's
defaults a first bootstrap made some 50,000 file calls (a hot-journal check, a header re-read and a
stat before each statement, every 4 KB page read through a 64 KB stream) and the daemon stalled for
minutes at "fetching authority certificates", while the same build bootstrapped in seconds under
wasmtime and in plain Node. The daemon is the database's only user and the cache is rebuilt from the
network, so the build compiles SQLite with exclusive locking, 16 KB pages, a 64 MB page cache and no
fsync (`SQLITE_FLAGS` in [`build/toolchain.mjs`](build/toolchain.mjs)), and the daemon makes the
lock-free `unix-none` VFS the default before Arti opens the database. A first bootstrap then makes
about 3,400 file calls and reaches Tor in under 20 seconds in Orivon.

**Why build paths are remapped.** Rust writes the source path of every crate into the program, for
panic messages, and a C compiler can do the same: built as it stands, the daemon held the path of
Cargo's registry under the builder's home directory and of the checkout it was built in, so two
checkouts built different bytes and a published build named who made it. The build writes Cargo's
directory as `/cargo` and `out/torsocks/` as `/torsocks` (`remaps` in
[`build/build.mjs`](build/build.mjs)), so `orivon-port verify` can rebuild the published tree to the
same bytes.

**Why the daemon prints so little on stdout.** Each write a spawned program makes waits until the
page has taken it. Events go to the control port; stdout carries only `hello`, `control`, `fatal`
and `exit`, what a page needs before the control port answers. Whatever the daemon writes on stderr
(a Rust panic among it) appears in the page's log.

**A more detailed log.** A file `torsocks/log-level` in the app's files holding `debug` or `trace`
raises the level of Arti's own log for the next start of the daemon.

**Why a control port, and not stdin.** A page that reloads cannot reach the child it spawned (a
child's lifetime is its app's, its stdin is the old page's). A loopback port lets any page of the
app, a reloaded one or a second tab, join the running daemon. The key lives in the app's files,
which only the app reads, so another program on this computer can connect but not give orders.

**Why services are served by the daemon, not by the page.** Visitors arrive as Tor streams inside
the daemon; serving them there needs no loopback hop and works while the page is busy. Files are
read in 64 KB chunks, so a large file never sits whole in memory.

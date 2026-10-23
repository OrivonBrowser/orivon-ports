# `apps/ollamagui/`: upstream Ollama GUI, unmodified, as an Orivon app

## About this build

**A community build by Orivon of Ollama GUI, not the official Ollama GUI.** Ollama GUI is a chat interface for models that run on your own computer through Ollama. This directory holds the recipe that builds it to run in Orivon; the upstream project did not make this build.

| | |
|---|---|
| Official project | [github.com/HelgeSverre/ollama-gui](https://github.com/HelgeSverre/ollama-gui) |
| Official downloads | The project publishes no downloads; its [README](https://github.com/HelgeSverre/ollama-gui#readme) lists the ways to run it |
| Pinned upstream | 2.0.5 (v2.0.5), commit `b79a7b8ca537` |
| This build's version | 2.0.5.1 (upstream 2.0.5, build 1) |
| Licence | MIT, upstream's own; served as `/LICENSE` beside the app, see [`UPSTREAM.md`](UPSTREAM.md) |
| Recipe | [`recipe.json`](recipe.json), [`orivon.json`](orivon.json) |
| In another browser | The app loads there, and this page adds a small corner notice that can be closed. Reaching Ollama from another browser needs Ollama to allow the page's address (its `OLLAMA_ORIGINS` setting); upstream's connection help explains how. |
| Updates | When upstream releases a new version, the pin is moved and the build is redone ([maintaining a port](../../.claude/skills/orivon-porting/maintain.md)); there is no schedule. The app has no update checker of its own. |
| Problems | [Report a problem with this build](https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=Ollama%20GUI): it goes to this repository's issue form, not to the upstream project's tracker. |

What Orivon adds: the page can reach Ollama on `localhost:11434` with no `OLLAMA_ORIGINS` setting. A request made under the grant carries no `Origin` header unless the app sets one, and Ollama's default origin check lets a request with no `Origin` through.

Known gaps in this build:

- **Only `localhost:11434` is reachable.** The manifest names that one address. An Ollama on another port, on another machine or on a remote host is refused by Orivon, whatever URL Settings holds. Another address needs another manifest.
- **`localhost` and `127.0.0.1` both reach it**, because a grant for `localhost` covers both loopback addresses.
- **The connection help is upstream's.** When Ollama is not running, the app still shows the `OLLAMA_ORIGINS=... ollama serve` line, which this build does not need.
- **The web app manifest's three icons** keep the root-absolute paths upstream writes. They matter only to an "install this site" prompt.

The sections below are for people working on the build.

**What lives here.** A recipe and a manifest. **No Ollama GUI source and no Ollama GUI build output is in this repository** -- see [`UPSTREAM.md`](UPSTREAM.md) for its licence and where it goes instead.

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json) | Where upstream is, at which commit, how to build it, and the licence copied to `/LICENSE` |
| [`orivon.json`](orivon.json) | The manifest: one connection grant, `localhost:11434` |
| [`UPSTREAM.md`](UPSTREAM.md) | The pin, the licence, what never crosses into this repository |
| [`../../docs/ollamagui-recon.md`](../../docs/ollamagui-recon.md) | The reconnaissance this port was built from |

## Running it

```bash
orivon-port run ollamagui
```

Then open `http://127.0.0.1:8889` in Orivon and accept the prompt, or `ollamagui.orivonstack.eth` once `orivon-port names` has written `out/names.json` and Orivon was started with `ORIVON_ETH_NAMES_FILE` pointing at it (the top-level [`README.md`](../../README.md)'s "Opening it by name instead of by port" has the exact command). Ollama has to be running on the same computer.

The install and the build run through `npx --yes bun@1.3.14`, because upstream's only lockfile is `bun.lock` and the host is not assumed to have `bun`. The build passes Vite's own `--base ./`, so every URL in the page is relative to the entry document.

## The seam

**None.** Ollama GUI has no Electron build, preload or main process, so there is no bridge and no `orivon.*` member to write; the page is upstream's web build. Orivon supplies one thing, the network grant, and the manifest asks for exactly that.

A cross-origin `fetch` from an app tab to a granted host goes out from Orivon's network layer instead of the page, with only the headers the app set. Ollama GUI sets `Content-Type` and nothing else, so no `Origin` is sent.

## What it needs from orivon-mvp

- A routed `fetch` to a granted `http://localhost:<port>` sends no `Origin` header unless the app sets one.
- A streamed response body reaches the app as it arrives, so a reply grows token by token.
- A grant for `localhost:<port>` also covers `127.0.0.1:<port>`.

## Design notes

**Why the manifest declares `net.tcp.connect`, not `net.https.connect`.** The app's default host is plain `http://localhost:11434`, and a cross-origin plain-`http` request from an app tab is checked against the TCP grant.

**Why `localhost:11434` and nothing broader.** `*:*` never reaches a loopback address, so a wildcard would not help, and a port range would let the page reach other local services. The port Ollama listens on by default is the narrowest set that does the app's job.

**Why the build passes `--base ./`.** Upstream builds with an absolute base, so its page names `/assets/...` and `/sw.js`, which escape a `/ipfs/<cid>/` mount. `--base ./` is a Vite build option, not an edit of upstream's source.

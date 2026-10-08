---
name: "orivon-porting"
description: Use when porting a third-party app (Electron, web or Node server) to run in Orivon, when judging whether a named app is portable, when writing or reviewing anything under `apps/<app>/`, when updating a port to a new upstream release, when the owner reports something broken in a ported app, when rebuilding or republishing ports (IPFS, IPNS, Explore, Web3 Score) after a change here or in orivon-mvp, when deciding whether a gap belongs in the bridge, the shell or a new capability, and when deciding which orivon-mvp app-behaviour rows and specs a port needs so that a future Orivon change cannot break it silently.
---

# Porting and maintaining apps in orivon-ports

**[`docs/porting-guide.md`](../../../docs/porting-guide.md) is the method and the one copy of it**:
the buckets, the escape test, the build traps, server apps, native code, Step 7. This skill is what
an agent needs on top of it: which job this is, the decisions that cost the most when taken wrong,
and the order of work. `CLAUDE.md` and `README.md` of this repository still apply in full.

A session started in `orivon-mvp` reaches this file through that repository's `orivon-porting`
pointer skill. Paths written `../orivon-mvp/...` are in that sibling checkout.

## Which job is this?

| The ask | Read next | Done when |
|---|---|---|
| "Port the app X", or "is X portable?" | [new-port.md](new-port.md), then [verify.md](verify.md) and [mvp-tests.md](mvp-tests.md) | The checklist below holds and the PR is merged |
| "X in app Y does not work" | [Port or Orivon?](#port-or-orivon) below, then [verify.md](verify.md) section The whole-app sweep | Every screen of Y was driven, not only the one reported |
| "Update Y to the latest release" | [maintain.md](maintain.md) section A new upstream release | The new pin builds from an empty `out/`, and the sweep passes |
| Orivon changed something a port uses (the shim, the broker, CSP, consent) | [maintain.md](maintain.md) section After an Orivon change | Every affected port is rebuilt, and republished if it is published |
| "Publish" or "republish" an app | [maintain.md](maintain.md) section Publishing | The name answers with the new build, and Explore and its scores follow |
| "Check all the ports" | [maintain.md](maintain.md) section Port health | Each app's row in that section is answered |

A one-line ask such as "Port the app X" means the whole method, done by you: recon, build, bridge,
manifest, tests, a live drive, the app's docs, the mvp behaviour check and the PR. The owner asks
for short replies and few tokens on small asks; a port is not a small ask.

## The rules that decide most calls

- **A port is upstream plus a bridge, never a fork.** Editing their source is allowed only where
  the guide's escape test says so.
- **The port supports everything a user does in the app**, not the first screen. The owner tests
  whole apps and reports what one-screen verification missed.
- **Build the app's Electron renderer target, never its web target** (`CLAUDE.md` Rule 8). The two
  differ in what the code does at run time, and the web target often cannot do the app's main job.
- **A gap in Orivon is fixed generically in Orivon, never patched in the port**
  (`../orivon-mvp/CLAUDE.md` Rule 20). The port's job is to say what it relies on;
  [mvp-tests.md](mvp-tests.md) turns that into tests Orivon's CI runs.
- **Refuse by name, with a reason.** A member nobody can honour ships refused; silence ships as a
  hang.
- **The served tree works on a host that does nothing**: an IPFS path gateway, any static server.
  No compressed bytes, no reliance on a server fallback, relative injected URLs.
- **Each app stands alone** (`CLAUDE.md` Rule 7). Copy a sibling's pattern; `src/` is where a
  pattern goes once every future port should get it free.

## Port or Orivon?

Triage every reported failure before fixing anything:

- **Orivon's fault** when a platform behaviour a page can see is wrong (a property descriptor, a
  permission, CSP, a secure context, consent), or a shell guard refuses something a legitimate app
  does. The same served bytes in plain Electron with Orivon's `webPreferences` are the control:
  change one variable at a time.
- **The port's fault** when the bridge breaks the contract upstream's preload keeps, the build
  wrapper emits something a static host cannot serve, or the manifest under-declares.
- **Neither**: live network state (a chain halted), a third party's limit (429, a missing API
  key), upstream's own behaviour, or the owner's checkout being behind. Say which, with evidence.

Before calling it a new Orivon bug, check open mvp pull requests and how old the owner's build is:
the fix may exist on a branch, or their `out/` may predate it.

An Orivon fault is fixed in orivon-mvp. From a session started in orivon-ports, hand the owner a
self-contained prompt for an mvp session (`CLAUDE.md` Rule 9): the behaviour in one generic
sentence, the evidence, and the test it needs ([mvp-tests.md](mvp-tests.md)). From a session started
in orivon-mvp, make the fix there yourself, in an mvp worktree, under that repository's rules. In
either case never weaken a security property from a porting session without asking the owner.

## Where a missing power goes

- **The per-app bridge**: the name is this app's own invention. Almost everything lands here.
- **`../orivon-mvp/src/shim-electron/`**: the app calls the real `electron` module, and covering it
  there gives every future port the same call free.
- **A new capability**: only when no existing `orivon.*` power can honour it. That is a change to
  `../orivon-mvp/src/contracts/`, the most expensive kind Orivon has.

If none of these is honest, the member is refused by name, and that ships.

## The shapes, and which app to copy

`npm run check:skill` fails while an app under `apps/` is missing from this table.

| App | Shape | Copy it for |
|---|---|---|
| `apps/freetube/` | Electron renderer built with a wrapped webpack config; named-member bridge; one web context | `src/build/webpack-kit.cjs` use, a `hooks.mjs` that injects an icon, a minted-token flow |
| `apps/asgardex/` | Upstream's own electron-vite build; fourteen preload globals; file-backed stores | Stores that must resolve defaults on first run, listeners that return an unsubscribe |
| `apps/ledger-wallet/` | An Electron renderer built by wrapping upstream's rspack config (target switched to a page, Node builtins answered by Orivon's shim); a preload plus an `ipcMain` handler set re-created in one bridge, the `electron` module answered by a bridge-installed object; a hardware (WebHID) grant; a monorepo built with pnpm and nx | `devices.hid` in a manifest, an rspack wrapper that asserts each patch, a bridge that keeps a password-protected file format byte-compatible, a recipe that provisions its own pnpm |
| `apps/element/` | Web build of a monorepo plus a generic-forwarder preload | A forwarder where every channel must be answered, a pnpm toolchain pinned into `out/` |
| `apps/airgap-vault/` | No preload, no bridge, `capabilities: {}` | The cheapest port: a recipe, a manifest and one HTML hook |
| `apps/the-lounge/` | Node server bundled with esbuild against Orivon's Node shim, run in a forked Worker, shown through a launcher page | Server apps (guide section Node server apps); needs `ORIVON_MVP_ROOT` |
| `apps/explore/` | A `site` recipe written here: no upstream, calls `orivon.*` itself | A page that must declare exactly what it probes |
| `apps/bisq-fake/` | A `site` recipe mock for filming; no domain, not a port | Nothing; it is exempt from the domain rule by name |

## Environment facts that bite every session

- **The owner's own `serve` usually holds every app's recipe port**, and their `npm run dev` watches
  `../orivon-mvp/out/`. Build in a worktree, serve on a spare `--port`, drive the shell from a
  scratch mvp worktree ([verify.md](verify.md)). Never stop a server you did not start.
- **Heavy commands go through `~/.claude/orivon-fleet/bin/heavy`**: builds, installs, vitest, any
  Electron launch. A hook refuses them otherwise, and the owner's machine crashes under load.
- **`ELECTRON_RUN_AS_NODE=1` is set in the ambient shell**: Electron launches only through
  `../orivon-mvp/scripts/run-headless.mjs`, which also keeps windows and sound off the owner's desktop.
- **The owner's checkouts are often dirty.** Work in a worktree off `origin/main`; never discard or
  commit their files; say what their checkout lacks once yours merges.
- **Other sessions work in the same repositories.** Re-read a file before editing it, and agree by
  message before moving an IPNS key or stopping anything shared.

## Done: the checklist for any change to a port

1. `npm run typecheck && npm test && npm run check`, and a new gate proven to fail on a real
   violation first.
2. `node src/cli.ts build <app> --rebuild` from an empty `out/<app>/` in your worktree (heavy).
3. The app driven headless in a real Orivon shell: the thing it is for, then every screen
   ([verify.md](verify.md)). Pass and skip counts read, not the exit code.
4. Step 7 done: the app's README lists the catalogue ids it relies on, and each gap has an mvp row
   and spec, or a prompt for one ([mvp-tests.md](mvp-tests.md)).
5. The app's README and `UPSTREAM.md` say what is true now: the pin, what works, what does not, what
   is blocked on Orivon (a fixed blocker is deleted, not annotated).
6. If the app is published: version build number raised, republished, Explore updated
   ([maintain.md](maintain.md)).
7. A branch, a PR, CI green, merged by you (`../orivon-mvp/CLAUDE.md` Rule 14 covers this
   repository); the owner told which of their builds is now stale.
8. What cost you the most is in [traps.md](traps.md), or in the app README's Design notes when it
   is true of that app only.

## Keeping this skill true

This skill rots exactly where the repositories move: a new CLI command, a new app shape, a new
capability, a check renamed. `npm run check:skill` keeps the mechanical half honest: every
repository path these files cite exists, every `orivon-port` command they name is one the CLI has,
and every app under `apps/` has a row above. The judgement half is yours: when a session teaches
something a later session would otherwise pay for again, put it here in the same pull request, as
what is true now (`CLAUDE.md` Rule 3), never as a story.

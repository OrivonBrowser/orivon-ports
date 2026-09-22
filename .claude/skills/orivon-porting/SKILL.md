---
name: "orivon-porting"
description: Use when porting a third-party Electron application to run as an Orivon app, when estimating whether a named app is portable at all before committing to it, when writing or reviewing an `apps/<app>/bridge/` file, when an app's own build config fights the port, or when deciding whether a missing power belongs in the per-app bridge or in the shell. Points at the porting guide for the method and adds the traps that cost the most.
---

# Porting a third-party Electron app to Orivon

**Read [`docs/porting-guide.md`](../../../docs/porting-guide.md) first.** It is the method — the
five buckets, the escape test, the bridge conventions, the two build traps — and it is the one
copy. This file adds only what an agent needs on top of it.

`apps/freetube/` is the worked example. Every number in the guide is measured there.

## Start with the tool, not with grep

```bash
node src/cli.ts recon <path-to-their-clone>
```

This replaces the hand-run greps: it walks the renderer, the preload and main, and prints the
evidence table plus a verdict. Three things about its output:

- **The member count is a floor.** Computed keys and `Object.assign` defeat a static read.
- **It skips `node_modules` and `dist`**, so its counts are lower than a bare `grep -r` over the
  clone. That is the point; do not "fix" a discrepancy against a grep that counted the
  dependency tree.
- **A zero for the preload means it did not find one**, not that there is none. Check the
  reported roots before believing it.

Write the recon down. `docs/freetube-recon.md` is the shape: a table of facts with `file:line`
evidence, a handler inventory grouped by what Orivon needs, and an explicit verdict. It is what
makes the cost estimable rather than open-ended.

## Then scaffold, do not hand-write

```bash
node src/cli.ts new <id> "<Name>"
```

The scaffold writes `bridge/members.json`, the app's own members file and its test. Then:

```bash
node src/cli.ts recon <clone> --emit <id>
```

That fills the declaration with every member recon found, all under `unclassified`. The build
refuses while any name is still there — bucketing each one is the judgment the guide's step 2
describes, and it is the part no tool does for you. Reproducing the refusal machinery, the inert
recorders or the `node:vm` harness by hand is how they drift; they are in `src/bridge/` and
`src/testing/`.

## Every port ships a tab icon

A prepared app with no icon renders a globe in the tab and in every bookmark tile, and Orivon's
favicon capture is stricter than a browser's. Check both halves on every port:

- **The served document must declare `<link rel="icon">` with a URL relative to the entry
  document.** Upstream's Electron build often has none at all (FreeTube), or a root-absolute one
  (ASGARDEX's `/favicon.ico`, which also escapes a path-gateway mount).
- **The icon file must be in the served tree.** The renderer build usually leaves it out: Vite
  does not copy `public/` into a renderer-only output, and a desktop app's icon normally lives in
  `resources/` or `_icons/`, outside what that build emits.

Do both with fields a port already has, never by committing their asset:

1. `recipe.json`'s `extraFiles` copies the icon out of the clone, e.g.
   `{ "from": "_icons/iconColor.png", "to": "orivon/<id>-icon.png" }`.
2. `apps/<id>/hooks.mjs` injects the `<link>` when upstream has none, or rewrites an existing
   root-absolute href to the relative path. `transformHtml` must be idempotent.

Pick the format Orivon accepts, not the one upstream ships. The shell's `src/main/favicon.ts`
re-encodes the declared icon to a `data:` URL and allows only bitmaps (`png`, `jpeg`, `gif`,
`webp`, `x-icon`, `vnd.microsoft.icon`) under **32 KB** — **SVG is refused**, and an `.ico` over
the cap (FreeTube's is 492 KB) is dropped. A 2–3 KB PNG, or the app's small `favicon.ico`, is
right; upstream's `logoColor.svg` is not.

`apps/freetube/hooks.mjs` is the inject shape and `apps/asgardex/hooks.mjs` the rewrite shape.
Verify by preparing the app and requesting the icon: it must answer `200` with one of the allowed
content-types, not `404` and not `image/svg+xml`.

## Where a missing power goes

Three places, and picking wrong is expensive:

- **The per-app bridge** — the name is this app's own invention. Almost everything lands here.
- **The shell's `src/shim-electron/`** — the app is calling the real `electron` module, and the
  shim covering it means every future port gets it free. This is in the *other* repository.
- **A new capability** — only when no existing `orivon.*` power can honour it. This is a change
  to the contracts, which is the most expensive kind of change Orivon has.

If the honest answer is "none of these", the member is **refused by name** with a reason. That is
a real answer and it ships.

## Traps that will cost you an afternoon

- **`ELECTRON_RUN_AS_NODE=1` is set in the owner's ambient shell.** It turns the Electron binary
  into windowless plain Node without erroring. Launching the shell to check a port must go
  through the shell repository's `scripts/run-headless.mjs`.
- **Metadata loading is not playback.** Gate the expensive end-to-end assertion on what the
  prepared build's own manifest declares, with an env override both ways.
- **Both FreeTube build traps produced a blank page with zero console errors.** Reading the
  source would not have found either. Run it, drive it, look at the window.
- **A `vitest run apps/<id>/x.test.ts` that matches nothing exits 0.** In this repository
  `vitest.config.ts` includes `apps/**`, so it works — but if you ever see a suspiciously fast
  green run, check the file count rather than the exit code.

## Scope

**Do not build a bridge generator.** The porting guide's last section records what it could and
could not do, and why it pays back at app #3 rather than app #2. With one port completed it is
tooling for a sample of one. If you think the third port has arrived, that section is the thing
to argue against — not this line.

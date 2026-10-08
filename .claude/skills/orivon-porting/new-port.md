# A new port, in order

The guide's steps are the method; this is the order a session works in and what each step costs
when skipped. Work in a worktree of this repository off `origin/main`, never the owner's checkout.

## 1. Triage before committing

- **Is it a target?** A licence on the allowlist in `scripts/check-licences.ts`; a repository that is
  neither archived nor moved (a desktop app merged into its web monorepo is common); still Electron,
  not migrated to Tauri; not a thin wrapper around somebody's website, which runs their server code
  and proves nothing trustless. `docs/port-candidates.md` sorts candidates by shape: page,
  page plus device, page plus native code, server, daemon.
- **Measure it**: `node src/cli.ts recon <path-to-their-clone>`. Its numbers are a floor, not a
  count:
  - computed keys and `Object.assign` defeat a static read, and a member name shared by two globals
    is counted once;
  - it reads only `.js .mjs .cjs .jsx .ts .tsx .vue .svelte`, so a `preload.cts` is invisible;
  - it looks for the preload under `<clone>/src/preload`, `<clone>/app/preload` and `<clone>/src`
    only, so a monorepo's
    desktop package needs its root named or a count by hand;
  - it skips `node_modules` and `dist`, so a bare `grep -r` over the clone counts more. That is the
    point, not a bug;
  - it does not apply to a server app (`docs/the-lounge-recon.md` is that shape's recon instead).
- **Write the recon down** as `docs/<app>-recon.md`: facts with `file:line` evidence, the handler
  inventory grouped by what Orivon needs, the capability ratio (members needing `orivon.*` over all
  members), and a verdict. A bridge heading past 500 lines is the guide's "not a target".
- Pin a **full commit sha**. When the owner names a release, re-read the preload at that commit, not
  at the default branch.

## 2. Scaffold

```bash
node src/cli.ts new <id> "<Name>"        # recipe, manifest, README, UPSTREAM.md, bridge files
node src/cli.ts recon <clone> --emit <id> # every member found, under `unclassified`
```

Then, before the first build:

- `UPSTREAM.md` must name the pinned sha and the licence, or `check:licences` fails.
- A port with no preload deletes `bridge/` and the recipe's `bridge` field. An empty declaration is
  refused on purpose.
- `orivon.json`'s `domain` and the recipe's `eth` stay equal (`check:manifest`); the scaffold writes
  `<id>.orivonstack.eth`. Version is `<upstream>.1`.
- The scaffold picks the next free port from 8875. The owner's server and mvp's e2e fixtures also
  live in 8872-8899, so check `ss -ltn` before trusting a free-looking port for a drive.

## 3. Build their app the way their desktop app is built

- Use **their Electron renderer target** and their own toolchain. A web target compiles flags such
  as `IS_ELECTRON` false and loses the code path the app's main job needs.
- **Install with the package manager they pin**, run from their tree: a vendored
  `node .yarn/releases/yarn-*.cjs`, `npx --yes yarn@<version>`, or pnpm installed into
  `out/<id>/` and put on `PATH`. Never `corepack enable`: with no `packageManager` pin it fetches the
  newest release and fails. The system `yarn` on Debian is a different program.
- **Build-time secrets** (API keys read from the environment at build) are baked into the bundle:
  without them some features fail at run time, often as a CORS error. Name which ones in the README;
  a change needs `--rebuild`.
- **Wrap their bundler config rather than replacing it**: `src/build/webpack-kit.cjs`
  (`requireFromClone`, `patchPlugins`, `retargetOutput`, `addBrowserFallbacks`). `retargetOutput`
  throws when any copy rule would still write outside the port's output; let it.
- **`hooks.mjs`** is for what the built HTML needs: an icon link, a `<base href>` rewrite, a script
  moved out of an inline `data:` URL the CSP blocks. `transformHtml` must be idempotent and never
  edits their bundles.

## 4. Make the output survive any static host

Prepare refuses compressed bytes (`src/portable.ts`). A file named `.json.br` ships plain bytes
under that name. A history-routed app ships `_redirects` (`/* /index.html 200`), which subdomain
and DNSLink gateways honour and path gateways do not. URLs the port injects are relative to the
entry document. Check by requesting the served tree with `curl`: the entry, a deep route, the
manifest at `.well-known/orivon.json`, the bridge, the icon.

## 5. Classify every member, then write the few that decide

The guide's Step 2 buckets, plus what the bridges here learned the hard way:

- **Reproduce upstream's contract on the empty first-run state.** Read how upstream's main process
  answers a member when nothing was ever saved: a store read that resolves a default must never
  reject, or the renderer shows an empty list or a spinner forever. Take defaults by evaluating
  upstream's own source at the pin, never by copying values by hand.
- **For each member, read how the renderer handles failure.** A rejection the caller never catches,
  or a synchronous throw during mount, escapes the app's own error handling: answer "nothing"
  instead (an updater that finds nothing newer).
- **A partial save merges** against defaults in upstream's main; the bridge does the same.
- **A forwarder preload must answer every channel**, refused or not; an unanswered envelope hangs.
- **Listeners return their unsubscribe**, where the app expects one.
- Test it with the `node:vm` harness in `src/testing/`: compare errors by name, never by
  `instanceof`, because the sandbox has its own realm.

## 6. Manifest and consent

- Declare what the app's main job needs and nothing it does not. `capabilities: {}` registers the
  app with no consent question at all.
- `*:*` never reaches a loopback or private address, and never a reserved port such as IRC's 6667
  and 6697: name those exactly.
- `crossOriginIsolated: true` when the app needs synchronous file access or forks.
- `consentGranularity: "all-or-nothing"` for an app that never knew Orivon; per-capability only for
  an app written for Orivon.
- Test the page before consent and after it: the tab becomes an app tab after the grant, and
  property descriptors, CSP and routed `fetch` change with it.

## 7. Tab icon

Every port ships one. The served document needs a `<link rel="icon">` relative to the entry
document, and the file must be in the served tree: renderer builds usually leave the desktop icon
out. `recipe.json`'s `extraFiles` copies it from the clone (`{ "from": "_icons/iconColor.png",
"to": "orivon/<id>-icon.png" }`) and `hooks.mjs` injects or rewrites the link. Orivon reads PNG,
JPEG, GIF, WebP, ICO, BMP, AVIF and SVG up to 128 KB, judged by bytes, not extension
(`../orivon-mvp/src/main/browsing/favicon-format.ts`). Verify the icon answers `200` with an image
type.

## 8. The app's own pages

- `README.md`: what works, what does not, what it needs from orivon-mvp (catalogue ids, see
  [mvp-tests.md](mvp-tests.md)), how to run it, and Design notes for every non-obvious choice.
- `UPSTREAM.md`: the pin, the licence, what crosses into this repository (nothing), and what to
  re-check when the pin moves.
- `docs/<app>-recon.md`: the measurement the port was committed on.

Then [verify.md](verify.md), [mvp-tests.md](mvp-tests.md), and the checklist in
[SKILL.md](SKILL.md). Listing the app in Explore and publishing it are owner calls; ask once,
default to "Coming soon" (`published: false`) in Explore's catalog if the owner wants it shown.

# Keeping a port alive

A port is never finished: upstream releases, Orivon changes under it, and every rebuild of a
published app starts a chain of dependent updates. This file is each of those jobs in order.

## A new upstream release

The release watcher (`.github/workflows/upstream-release.yml`) starts this job: every four hours it
compares each port's pin with its upstream's newest stable release, and keeps one issue per app,
"Upstream release available: <App> <tag>", with both commits, the release link and the first lines
of its notes. The issue closes itself once the pin is at the release or past it. Which tags count
is the recipe's: `upstream.tagPattern` and `upstream.prerelease` ([recipe-format.md](../../../docs/recipe-format.md)).
It never opens a pull request; setting the repository variable `PIN_PRS` to `true` makes it open a
draft one that moves `upstream.ref` and nothing else, once the organisation lets Actions do that.
To build the new version before editing the recipe, `node src/cli.ts build <app> --ref <tag or full
sha> --rebuild` takes it for that one command.

1. **Settle what "latest" means.** Upstream's latest release can be older than the current pin (a
   port may already sit on a development commit past it). When the release and the development head
   differ, ask the owner which once, and default to the release.
2. **Move the pin**: the full sha in `recipe.json`'s `upstream.ref`; `UPSTREAM.md` names that sha and
   says truthfully which release or branch it is; `orivon.json`'s version becomes that release's own
   version with no build number (`1.12.33`): `release` makes it `1.12.33.1` when the app is published.
3. **Re-measure the surface at the new pin**: `node src/cli.ts recon <clone> --emit <id>` merges new
   member names into `unclassified`, and the build refuses until each is bucketed. Its **Suggested buckets**
   section is a first read of each new member, not a decision. A removed member
   is deleted from the declaration. `--emit` leaves an already-bucketed global untouched, so a member added to one
   shows only in the plain `recon` list: compare it with the declaration ([traps.md](traps.md)).
4. **Re-check what the app's own pages say to re-check** when the pin moves: `UPSTREAM.md` and the
   README's Design notes (ASGARDEX's copied default stores, FreeTube's patched webpack plugins,
   whose patch counts throw when upstream's config changes shape).
5. **Build from an empty `out/<app>/`** in a worktree (`fetch --force`, then `build --rebuild`,
   heavy). A multi-gigabyte clone may be reused when its `HEAD` is the new pin.
6. **Sweep the app** ([verify.md](verify.md)), and run the same drive against the old build as a
   baseline: a failure both share is not this bump's.
7. **Step 7 again** ([mvp-tests.md](mvp-tests.md)): a new upstream feature can rely on a behaviour
   nothing proves yet.
8. If the app is published, republish it (below). Explore's icon sources in
   `apps/explore/UPSTREAM.md` pin upstream commits too.

## After an Orivon change

What reaches a port at build time needs a rebuild here; what reaches it at run time needs a
re-check, not a rebuild.

- **Build time**: the Node shim and its bundler plugin (The Lounge builds against
  `$ORIVON_MVP_ROOT`, so point it at an mvp tree equal to `origin/main`), and anything under this
  repository's `src/` that `prepare` injects (the bridge kit, the Orivon hint). Rebuild every app
  that takes it, then republish the published ones.
- **Run time**: the broker, preload, consent, CSP, the permission gate, routed networking. Each
  change that alters what an app can count on carries a line under `### Changed for apps` in
  `../orivon-mvp/CHANGELOG.md`, naming the ports to recheck. Recheck those with a drive.
- **A changed manifest means a new consent.** The owner restarts Orivon from an updated build (an
  older build may refuse a newer manifest), closes the app's old tabs (a forked server keeps running
  the old bundle) and accepts the new question. Tell them so in those words.
- **A workaround in a port that an Orivon fix makes unnecessary** goes once the mvp change is merged
  and the port is re-verified without it; the README's blocker line goes in the same change.

## Publishing

Publishing is the owner's call the first time; republishing an app that is already published,
after a merged change to it, is routine. Where the pinning host is and how to reach it is
deliberately not in this repository; a session allowed to publish has it in its local instructions.
Every publish ends by updating the host's own summary of what runs there.

**The chain**, because a new build changes the app's bundle hash and its CID, and three other
things are keyed by them:

1. **Release** from `origin/main` in a worktree: `node src/cli.ts release <app>` builds the app and
   compares the tree with the one last published, recorded in `apps/<app>/published.json`
   (`docs/recipe-format.md`). A tree that differs gets its version's last number raised by one in
   `orivon.json`, in the built tree and in the record; the same tree keeps its version, so
   republishing the same bytes is not an update. After a raise, commit `orivon.json` and
   `published.json`, merge them, and run `release` again on the merged commit: it changes nothing and
   names the folder to publish, whose manifest records that commit as `source.portsCommit` (only a
   checkout that is exactly at a commit can). `prepare` is deterministic: re-preparing the pinned
   clone at the same orivon-ports commit reproduces a published tree byte for byte.
2. **Declare and check**: `node src/cli.ts hash out/<app>/static --check` passes (it refuses a
   changed tree that still carries the published version, and names `release`); the page carries
   the Orivon hint; the app's tests pass.
3. **Pin and name it** on the host: `ipfs add -r -H --cid-version=1 -Q <dir>` (`-H` is required,
   because the manifest lives in `.well-known/`), keep the old CIDs pinned so old links work, then
   `ipfs name publish --key=<app> /ipfs/<cid>`. That flag set is the only one used for app trees:
   it is the constant in `src/ipfs-add.ts`, which `node src/cli.ts cid <dir>` and the attested
   build use, and every published CID was made with it. The browser's release packages use a
   different set, which writes out each default; do not mix them up. The CID follows from the
   Kubo version's defaults too (chunking, hash, layout), so a CID is quoted with the Kubo that made
   it: the attested build prints it, and uses the same version the browser's release workflow does.
   Every published app has its own IPNS key, and its
   `.eth` name points at that key, so a republish needs no ENS transaction. Two sessions never move
   one key at once: agree by message first.
   **Optional, before pinning: build it attested.** The `Build attested` workflow (Actions, Run
   workflow, choose the commit and name the app) builds the app from an empty clone on a fresh
   runner, checks the tree against its declaration and its `source.portsCommit`, packs
   `out/<app>/static` into `<app>-static.tar.gz`, computes the CID from the tarball's contents, writes
   the commit, the bundle hash, the CID and the flags into the run summary, and attests the tarball.
   On the host: download the artifact (`gh run download <run> -R OrivonBrowser/orivon-ports`), run
   `gh attestation verify <app>-static.tar.gz -R OrivonBrowser/orivon-ports`, unpack it and check
   that `node src/cli.ts cid <unpacked>` prints the summary's CID, then pin the unpacked tree with
   the command above. A hosted runner has a fixed disk and time limit, so the heaviest toolchains
   (Ledger Wallet, Element) may not fit; build those on a machine and check them with `verify`.
4. **Verify from outside**: the page, the manifest and the icon through public gateways, by CID
   and by IPNS name. Some resolvers hijack gateway hosts; resolve through DNS-over-HTTPS.
   Then `node src/cli.ts verify <app>` (heavy: it rebuilds): it reads the published manifest and
   ddoc file through `https://<domain>.limo/` (or `--from <https address of the tree>`), rebuilds the
   app from an empty clone at the commit in `source.portsCommit` (or `--commit <sha>`), and prints
   MATCH or MISMATCH with both bundle hashes, both CIDs when `--cid` gives the published one, and the
   files that differ. A tree published before `source.portsCommit` existed needs `--commit`.
5. **Web3 Score**: the official provider (the sibling repository `web3-score-manager`, its
   `provider/`) judges a build by its ids. Its `web3-score ids <built-tree>` gives the bundle
   hash; add it and the CID to that app's evaluation (at most eight ids, so the oldest pair
   goes), run its `check` and tests (it has no CI), merge, build, and move its `web3-score` key.
   Judging rules are in its `provider/README.md`.
6. **Explore**: the app's `ipfs` CID in `apps/explore/site/catalog.js`, and the snapshot entry keyed
   by that CID in `site/judgements.js` (`apps/explore/test/score.test.ts` fails on a CID the
   catalog lacks). Then
   Explore is itself republished, and its own new ids go to the provider. Batch both apps' ids into
   one provider change where you can.
7. **Tell the owner**: the CID, the `ipns://` name, and for a new app the ENS contenthash to set
   (only they sign). The label is the manifest's `domain`, never the app id (`airgapvault`, not
   `airgap-vault`).

A judged level counts only at the manifest's `domain`, never at a bare `ipfs://` CID, and only once
that name's contenthash is set. A provider address ends in `/score`.

## After a merge: the owner's side

The owner runs ports from their own checkout with their own `serve`. A merged change is not in
their hands until:

- their checkout is fast-forwarded (`git merge --ff-only origin/main` when its dirty files do not
  overlap the change; otherwise name the overlapping files and stop);
- the app is rebuilt there (`node src/cli.ts build <app>`; `serve` warns about a stale build and
  never rebuilds);
- their `serve` is restarted, and a server app's old tabs are closed.

Say which of these you did and which is theirs, with the exact commands.

## Port health

Run this when asked to check the ports, and on any port you touch:

| Check | How |
|---|---|
| Built from the pin | `node src/cli.ts list`; `serve` warns when a build predates its pin |
| Pin against upstream | The open "Upstream release available" issues, or the Pin vs upstream column of the Status page (the pinned commit's date and the newest upstream release's); else upstream's latest release and default branch, against `upstream.ref` |
| Published copy current | `hash out/<app>/static --check` against the CID in Explore's catalog; `verify <app>` for the published tree itself |
| Build number raised since the last publish | `node src/cli.ts release <app>` reports whether the build differs from the recorded one; `npm run check:version` keeps the record at or below `orivon.json`'s version |
| Catalogue ids named | The README's What it needs from orivon-mvp lists row ids ([mvp-tests.md](mvp-tests.md)) |
| Blockers still true | Each "blocked on orivon-mvp" line, re-checked against mvp `main`; a fixed one is deleted |
| Icon | The served tree answers its `<link rel="icon">` with an image under 128 KB |
| Docs true | README, `UPSTREAM.md` and the recon note match the recipe, the manifest and the code |

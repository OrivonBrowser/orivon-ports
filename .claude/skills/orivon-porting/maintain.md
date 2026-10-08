# Keeping a port alive

A port is never finished: upstream releases, Orivon changes under it, and every rebuild of a
published app starts a chain of dependent updates. This file is each of those jobs in order.

## A new upstream release

1. **Settle what "latest" means.** Upstream's latest release can be older than the current pin (a
   port may already sit on a development commit past it). When the release and the development head
   differ, ask the owner which once, and default to the release.
2. **Move the pin**: the full sha in `recipe.json`'s `upstream.ref`; `UPSTREAM.md` names that sha and
   says truthfully which release or branch it is; `orivon.json`'s version becomes `<upstream>.1`.
3. **Re-measure the surface at the new pin**: `node src/cli.ts recon <clone> --emit <id>` merges new
   member names into `unclassified`, and the build refuses until each is bucketed. A removed member
   is deleted from the declaration.
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

1. **Build** from `origin/main` in a worktree, with the version's build number raised
   (`<upstream>.<build>`, `docs/recipe-format.md`). `prepare` is deterministic: re-preparing the
   pinned clone reproduces a published tree byte for byte.
2. **Declare and check**: `node src/cli.ts hash out/<app>/static --check` passes; the page carries
   the Orivon hint; the app's tests pass.
3. **Pin and name it** on the host: `ipfs add -r -H --cid-version=1 -Q <dir>` (`-H` is required,
   because the manifest lives in `.well-known/`), keep the old CIDs pinned so old links work, then
   `ipfs name publish --key=<app> /ipfs/<cid>`. Every published app has its own IPNS key, and its
   `.eth` name points at that key, so a republish needs no ENS transaction. Two sessions never move
   one key at once: agree by message first.
4. **Verify from outside**: the page, the manifest and the icon through public gateways, by CID
   and by IPNS name. Some resolvers hijack gateway hosts; resolve through DNS-over-HTTPS.
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
| Pin against upstream | Upstream's latest release and default branch, against `upstream.ref` |
| Published copy current | `hash out/<app>/static --check` against the CID in Explore's catalog |
| Build number raised since the last publish | `orivon.json`'s version against the published manifest |
| Catalogue ids named | The README's What it needs from orivon-mvp lists row ids ([mvp-tests.md](mvp-tests.md)) |
| Blockers still true | Each "blocked on orivon-mvp" line, re-checked against mvp `main`; a fixed one is deleted |
| Icon | The served tree answers its `<link rel="icon">` with an image under 128 KB |
| Docs true | README, `UPSTREAM.md` and the recon note match the recipe, the manifest and the code |

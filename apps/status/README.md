# `apps/status/`: whether Orivon's sites, names and releases are served right now

## About this page

**Orivon Status is a page that tells a person whether Orivon's sites, names and releases are served right now. It is written by Orivon in this repository and is not a port.**

| | |
|---|---|
| Version | 0.1.5 |
| Source | This directory: [`recipe.json`](recipe.json), [`orivon.json`](orivon.json), [`site/`](site/) |
| Licence | This repository's, [AGPL-3.0-only](../../LICENSE) |
| In another browser | The page works there. It adds a small corner notice that can be closed. |
| Updates | Written in this repository, so a change here is the update; there is no schedule. |
| Problems | [Report a problem with this page](https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=Orivon%20Status): it goes to this repository's issue form. |

Known gaps:

- Every check runs from the visitor's own browser and network, so a filtered network can give a different answer from another's.

The sections below are for people working on the page.

**What lives here.** A page written in this repository that tells a person, truthfully, whether
each of Orivon's IPFS sites, its `ipns://` names, its `.eth` names and its GitHub releases are
being served at this moment. Every check runs in the visitor's own browser and does the work
itself: plain HTTPS requests to public Ethereum RPCs, the public IPFS routing service and public
IPFS gateways, and every block it fetches is hash-checked in the page. It uses no Orivon IPFS or
ENS capability, so it reads the same in any browser. This is a `site` recipe, like
[`apps/explore/`](../explore/); it is served as `status.orivonstack.eth` in development.

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json) | A `site` recipe: port 8893, served as `status.orivonstack.eth` |
| [`orivon.json`](orivon.json) | The manifest: one capability, `net.https.connect`, naming the eight hosts the page contacts |
| [`site/index.html`](site/index.html) | Markup only; one module script, every URL relative |
| [`site/status.css`](site/status.css) | Light and dark themes through custom properties; tables become labelled cards under 720 px |
| [`site/icon.svg`](site/icon.svg) | The tab icon |
| [`site/targets.js`](site/targets.js) | The sites, their keys, Swarm feeds and names, the releases rule, the gateways, RPCs and routing service. Data only |
| [`site/main.js`](site/main.js) | Entry: starts the checks, redraws rows as they finish, runs them again on request |
| [`site/checks.js`](site/checks.js) | The per-row pipeline, the releases check, and three rows at a time |
| [`site/content.js`](site/content.js) | The content step: walking a file's blocks, listing and sampling a folder |
| [`site/fetchers.js`](site/fetchers.js) | Every request: timeouts, the request log, gateway fallback, RPC calls, records, providers, releases |
| [`site/verdict.js`](site/verdict.js) | Pure: which record wins, whether a name is right, the verdict sentence, the banner and tiles |
| [`site/releases.js`](site/releases.js) | Pure: the CID in a release body, and which releases are checked |
| [`site/derive.js`](site/derive.js) | Pure: the record's end of life and its 24-hour flag, the provider count and its single-provider flag |
| [`site/pins.js`](site/pins.js) | Pure: an app's pin from its recipe, the newest release that counts, and the days between them |
| [`site/score.js`](site/score.js) | Pure apart from the hash: the bucket an identifier is filed under, and the evaluation found in it |
| [`site/keccak.js`](site/keccak.js), [`ens.js`](site/ens.js) | Pure: Keccak-256, namehash, the two `eth_call` payloads, ABI and contenthash decoding (`ipns://`, `ipfs://` and Swarm) |
| [`site/cid.js`](site/cid.js), [`protobuf.js`](site/protobuf.js), [`dagpb.js`](site/dagpb.js), [`cbor.js`](site/cbor.js), [`bytes.js`](site/bytes.js) | Pure: varints, base32 and base36, CIDs, the protobuf and CBOR slices needed, dag-pb and UnixFS |
| [`site/ipns.js`](site/ipns.js) | Pure apart from WebCrypto: parse an IPNS record, verify its V2 signature |
| [`site/verify.js`](site/verify.js) | A block against the hash in its CID |
| [`site/view.js`](site/view.js), [`format.js`](site/format.js), [`dom.js`](site/dom.js) | Drawing, number formats, element building with no `innerHTML` |
| [`test/`](test/) | Unit tests with real fixtures (a release folder block, a file root block, an IPNS record). Never served |

## Running it

```bash
orivon-port run status        # prepares site/ into out/status/static, serves 127.0.0.1:8893
orivon-port names             # writes out/names.json, which now maps status.orivonstack.eth
```

There is no build: a change under `site/` is live on the next `run`. In Orivon the page asks once
for the right to reach its eight hosts; in any other browser it just runs.

## What it does

Three rows are checked at a time, and each row shows its result the moment it finishes.

1. **Names.** For each `.eth` name of a row, the page asks the ENS registry for the name's resolver
   and the resolver for its contenthash, through the first Ethereum RPC that answers. The name is
   *right* when the contenthash is this row's `ipns://` key, or its Swarm feed (`bzz://` and the feed
   manifest's reference, which `site/targets.js` lists as the row's `feed`); the row says which. Another
   Swarm address is not right. Otherwise it says where the name points, that it has no contenthash,
   that it has no resolver, or that no RPC could be asked.
2. **Record.** The IPNS record is requested from the public routing service and two public gateways
   (orbitor and filebase), every answer is kept, and each is parsed and its signature checked. The highest sequence among the
   records that are valid and not expired wins; a source that serves a lower sequence is named as
   holding a stale copy.
3. **Content.** From the winning record's CID, the root block is fetched and hash-checked. A
   *site* is read through its whole `index.html`: every block of the file is fetched, six at a time,
   each hash-checked, and the sum must equal the size the file's root declares. A *folder* (the
   newest release) is listed, and for each file the page fetches its root block and one random leaf
   deeper in the file, so a large package is sampled, not downloaded.
4. **Providers.** The routing service is asked how many peers announce the root CID. The page
   shows a count and never a peer. A count of exactly one is flagged, and so is a count of none.
5. **Record valid until.** The end of the winning record's validity, with the time left. A record
   with under 24 hours left is flagged; one that has ended is broken. The date comes from the record the
   page already fetched.
6. **Web3 Score.** For the build's CID (`cid:<cid>`), the page reads the file of the Web3 Score
   provider Orivon Attila publishes at the bucket that identifier hashes to, and shows the level and
   the date of the evaluation. "No evaluation for this build" is the provider holding none for that
   CID, which is the case for every build it has not judged; a provider no gateway could reach is
   shown as such, never as "none".
7. **Pin vs upstream.** For an app that is somebody else's, the recipe on the ports repository's
   main branch says the pinned commit; GitHub gives that commit's date and the newest upstream
   release that counts (not a draft, not a pre-release unless the recipe says upstream publishes its
   releases that way, and a tag the recipe's `tagPattern` accepts). The cell shows both dates and how
   many days apart they are. It is information, not a verdict: a pin may sit on purpose behind or
   ahead of a release.

A site row is **Works** only when every expected name is right, a valid record was found, its page
(`index.html`) arrived whole and matched its hash, and at least one provider is listed. A release row
is Works only when every file's sampled blocks arrived and matched their hashes. It is **Slow** when all of that holds but
the row took over 15 s, **Broken** with its first failing step in one sentence otherwise, and **Not
sure** when a check itself could not be made (no RPC answered, the routing service was unreachable,
a sharded folder). Not sure is never counted as working.

The releases table lists the GitHub releases: the CID is the `ipfs://` address in the release body's
"On IPFS" section. The newest three that have one must be served and are checked as folders; older
ones are marked not kept; a release with packages but no address says its release workflow failed.
The Newest release row says which release its record points at.

## Design notes

**Everything is checked from the visitor's browser.** A status page that asked its own server would
report the server's view. Here a visitor sees what a visitor can reach, and the request list under
each row (host, status, seconds) is the evidence. The gateways, RPCs and routing service are public
services this repository does not run; a failure of one of them shows as that service failing, and
the next one is tried.

**What a "Works" proves.** That, just now, the winning record names a build, the build's folder and
`index.html` (or the sampled blocks of each release file) were fetched from a public gateway and
matched their hashes, and some peer announces the content. It does not prove that the page runs, that
every file of a site (a script, an image) is served, that a release file is complete (only its root
block and one random leaf are fetched), that a gateway not tried would also serve it, or that the
file is safe to run. A random leaf can pass while another fails; a second run samples another.

**A name at a Swarm feed is right, not proven current.** The page checks that the name's contenthash is
the site's own feed and never reads the feed. The content it fetches, hashes and counts providers for is
the build the IPNS key names, which is what the feed follows.

**What a "Broken" may be.** A public gateway being slow or rate limiting this visitor looks the same
as content that nobody serves. The page tries every gateway before it says so, but a visitor behind a
network that blocks those gateways sees failures the rest of the world does not.

**Signatures need Ed25519 in WebCrypto.** Where the browser has none, the record's signature reads
*not checked* and the row carries a note; the record is still used, and nothing else about the row is
weakened. IPNS names are keys, so the public key to check against is inside the name itself.

**Blocks are hash-checked here, not by the gateway.** The page asks for the raw block
(`?format=raw`), hashes it with WebCrypto (a small SHA-256 stands in on an insecure origin) and
compares the digest with the CID. A gateway that sends other bytes is treated as having failed.

**The routing service's IPNS answer goes through its own cache entry.** Its CDN caches an answer
without the CORS header when the first asker was not a browser, then hands that copy to every
browser, which must refuse it. The page asks `/routing/v1/ipns/<key>?client=orivon-status`, a cache
entry only browsers fill, so it always carries the header; the service ignores the parameter. A
source that does not answer is named in the record cell, which says how many answered and how many
of those agree.

**A row's time is what a visitor waits.** The fastest valid record plus the content step (or the
providers question, if slower), or the slowest name lookup. A record gateway that times out
does not make a row Slow.

**GitHub's unauthenticated limit is 60 reads an hour per network.** One load reads three things per
port (the recipe, the pinned commit, the upstream's releases), so the answers are kept in the page's
storage for an hour, and a visitor on a rate-limited network sees "not checked" in that cell and
nothing else changes. Storage that is blocked only means every load asks again.

**The page has no Orivon dependency.** Nothing calls `window.orivon`. The manifest's one
capability, `net.https.connect`, lets Orivon build the page's `connect-src` from the eight hosts in
`site/targets.js`; `test/manifest.test.ts` requires the two lists to match.

**This page has a row of its own.** Until something is published under its key the row reads
Broken (no record); that is the truth, not a special case.

**The privacy line.** Provider counts are shown, never the peers behind them, and the page names no
server of Orivon's own: the answer to "is it announced" is any provider at all.

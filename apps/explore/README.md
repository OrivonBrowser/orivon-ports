# `apps/explore/`: a directory of Web3 sites, each with its Web3 Score, and the Orivon apps marked

**What lives here.** A page written in this repository that lists Web3 sites by category, shows
each one's Web3 Score as Web2, Web2.5 or Web3, and marks which of them are Orivon apps. It also
lists, apart, the Web2 sites of the same projects. It is not a port: it holds no code of anyone else's, opens
no socket of its own, and today declares no capability. Listed sites are independent of
Orivon, and a listing is not an endorsement. This is a `site` recipe, like
[`apps/bisq-fake/`](../bisq-fake/); it is served as `explore.eth` in development.

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json) | A `site` recipe: port 8891, served as `explore.eth` |
| [`orivon.json`](orivon.json) | The manifest: it registers the origin and declares no capability |
| [`site/index.html`](site/index.html) | Markup only; one module script, every URL relative |
| [`site/explore.css`](site/explore.css) | Light and dark themes through custom properties, one layout down to 360 px |
| [`site/icon.svg`](site/icon.svg) | The tab icon |
| [`site/main.js`](site/main.js) | Entry: reads the address bar, renders a view, wires search, Include Web2 and keys, asks Orivon for scores |
| [`site/catalog.js`](site/catalog.js) | The categories and the sites. Data only |
| [`site/score.js`](site/score.js) | A card's Web3 Score: the level Orivon would show, and its Web2 / Web2.5 / Web3 mark |
| [`site/judgements.js`](site/judgements.js) | The snapshot of Orivon Attila's judgements shown when Orivon gives none. Data only |
| [`site/addresses.js`](site/addresses.js) | Which address a click uses, and the chips a card shows |
| [`site/filter.js`](site/filter.js) | Which sites are Web3; search, section and category filters; grouping; counts |
| [`site/router.js`](site/router.js) | The address bar as state |
| [`site/monogram.js`](site/monogram.js) | A card's initials tile and its colour |
| [`site/directory.js`](site/directory.js) | Navigation, cards and the empty state |
| [`site/dom.js`](site/dom.js) | Element building with no `innerHTML` |
| [`site/orivon.js`](site/orivon.js) | The only module that touches `window.orivon`, the Web3 Score question included |
| [`site/lab/`](site/lab/) | The Lab: `lab.js` renders it, `probes.js` lists the probes, `declarations.js` and `state.js` are pure |
| [`test/`](test/) | Unit tests for the pure modules and for the manifest. Never served |

## Running it

```bash
orivon-port run explore       # prepares site/ into out/explore/static, serves 127.0.0.1:8891
orivon-port names             # writes out/names.json, which now maps explore.eth
```

There is no build: a change under `site/` is live on the next `run`. Open the served address in
Orivon to see the Orivon marks and the Lab's environment panel, and in any other browser to see
the directory as it reads there.

## What it does

- **Three sections.** *Web3 sites* opens first: every Orivon app, and every site published at an
  ENS name or an IPFS address. *Web2 sites* holds every other site, reached at an ordinary web
  address. *All sites* holds both. *Orivon apps* lists the apps that use what only Orivon gives a
  page. Under them, the categories (chips under 720 px) count and show the section being browsed.
  The address bar holds the view: `#/`, `#/web2`, `#/all`, `#/orivon`, a category as `#/c/<id>`,
  `#/web2/c/<id>` or `#/all/c/<id>`, `#/search?q=`, and `#/lab`.
- **Search.** The box searches the whole directory, the Web3 sites only. *Include Web2*, beside
  it and off when the page opens, adds the Web2 sites. With it off, Web2 matches are counted and
  offered, never silently dropped. Its state is part of a search's address (`&web2=1`). `/`
  focuses the box; Escape clears it and goes back to the page the search started from.
- **Web3 Score.** Every card with an address carries a mark in the address bar's words and
  colours: **Web2** for Level 1, **Web2.5** for Levels 2 and 3, **Web3** for Level 4. A site at a
  web address alone is Level 1. A site at an ENS name or an IPFS address is Level 2, which Orivon
  observes by checking every file, unless a Web3 Score provider judges it Level 3 or 4. The mark's
  tooltip says which level, why, and who judged it; the footer names the provider.
- **Addresses.** A site may have a web address, an ENS name and an IPFS address. Inside Orivon a
  click prefers the ENS name, then IPFS, then the web address, so a `.eth` link loads through ENS
  and IPFS, verified. In any other browser it prefers the web address, then falls back to
  `https://<name>.eth.limo/` and `https://<cid>.ipfs.dweb.link/`. A card shows every address.
- **The Orivon mark.** A site with an `orivon` field gets an *Orivon app* badge, whether it was
  built for Orivon or ported to it. A port also links to the project it was ported from. An app
  that runs only in Orivon has no link outside it: its button says why. An app that is not
  published yet is listed with no button and the words *Coming soon: not published yet*.
  Inside a category, the Orivon apps you can open come first, then the other Web3 sites, then the
  Web2 sites, and the announced apps last.
- **Suggest a site.** The footer links to an issue form that asks for the name, a category, an
  address and a one-line summary.

## Where a score comes from

Inside Orivon, the page asks for the judgement of the Web3 Score provider the user chose in
Settings, once for each Web3 site, at the address its card opens. The answers replace the
snapshot as they arrive, named after that provider. The page asks through
`orivon.trust.websiteScore(address)`, which answers `{ provider, level }`: `provider` null when
the user chose none, `level` null when the provider has no judgement. **That member is not in
Orivon's API yet**; until it is, and whenever Orivon answers that no provider is chosen, the page
shows its snapshot. A Web2 site is never asked about: Orivon looks a site up only over Level 2.

Outside Orivon, and until Orivon answers, the page shows `site/judgements.js`: Orivon Attila's
website levels and the day they were read, for the CIDs the catalog lists (`website`) and for its
`.eth` names (`ens`, each with the CID the name pointed to that day). To refresh it, in
`web3-score-manager` run `node src/cli.ts list`, copy the level of each `cid:` identifier that
`site/catalog.js` lists, resolve each `.eth` name to its CID again, and copy the level Attila gives
that CID. `test/score.test.ts` fails when the snapshot names a CID or a name the catalog no longer
lists, so a rebuilt port never inherits the judgement of its previous build. A `.eth` name that
moved to new content after the read day keeps its old level on the card until the next refresh;
the footer says the score covers what the name served that day.

## Adding a site

Add one line to `SITES` in [`site/catalog.js`](site/catalog.js). Its section follows from its
addresses: an `orivon` field, an `ens` name or an `ipfs` CID makes it a Web3 site, a `web` address
alone a Web2 site. `test/catalog.test.ts` checks the shapes: kebab-case unique ids, a category that exists, an https web address, a `.eth` name,
a CIDv1 for `ipfs`, a summary under 90 characters with no full stop. An `ens` name belongs there
only when it loads through a gateway and serves the named project's own working, current site
(not a snapshot the project's web address has moved on from), and an independent source ties the
name to that project: the name's ENS text records, the project's
official site, docs or repository, or, for a subname, the project's parent name. Only an Orivon app with
`published: false` may have no address.

## The Lab (`#/lab`)

The Lab reports what Orivon says about this page (whether it is in Orivon, the API version,
whether the origin is registered, the declared capabilities, the grants held, the consent
granularity) and lists probes that check it. Outside Orivon it says so and disables Run.

A probe is one module in `site/lab/probes/`, listed in `site/lab/probes.js`:

```js
export default {
  id: 'manifest-roundtrip',
  title: 'Orivon registered the manifest this page serves',
  capability: null,          // or a capability kind such as 'https.connect'
  declares: {},              // the fragment of the manifest's "capabilities" it needs
  async run ({ orivon, served }) { return { ok: true, detail: '...' } }
}
```

`orivon` is the capability API and `served.manifest()` reads the manifest this origin
publishes. A probe's state is derived, never stored: *not in Orivon*, *not declared* (the
manifest lacks what `declares` names), *declared, not granted* (the card offers Request) or
*granted*; a probe that needs no capability is *ready*. `test/manifest.test.ts` merges every
probe's `declares` and requires `orivon.json` to say exactly that.

The two probes today need no capability: `manifest-roundtrip` compares the registered manifest
with the one served at `.well-known/orivon.json`, and `grants-within-manifest` checks that no
grant exceeds what the manifest declares.

## Design notes

**Nothing here is a third party's.** A card's tile is initials on a colour taken from the site's
id, because a logo is an image and somebody's trademark, and a site directory may hold only
`.html`, `.css`, `.js` and `.svg` (`check:no-upstream`). The page loads no remote image, font or
script, and its policy would refuse them: an installed bundle's policy admits no inline script,
and images, fonts and fetches only from its own origin and granted hosts.

**Only `orivon.js` touches `window.orivon`.** Everything else asks it, so the page works the same
in any browser and the capability layer has one place to change. `window.orivon` exists in every
Orivon tab, so existence means "this is Orivon", not "this app was granted anything".

**The Lab moves to its own origin when its first probe needs a capability.** Grants attach to the
origin, not to a page of it. If Explore's manifest declared a capability for a probe, the consent
for it would belong to the directory too, and everyone who only wants to browse would meet a
dialog. So Explore declares `"capabilities": {}`, which registers the origin and shows no dialog,
and `test/manifest.test.ts` fails the day a probe adds a declaration. That failure is the cue to
give the Lab its own recipe and manifest, and to keep this one empty.

**A score is read, never fetched by the page.** The page sends no request of its own, which is
what Orivon Attila's Level 4 judgement of Explore rests on. Fetching a provider's files on every
visit would add a connection, one a blocked gateway can stall, and would show Orivon's provider
to a user who chose another. So the judgement comes from Orivon, which already asks the user's
provider and caches its answers, and the snapshot, named and dated, covers the rest.
The snapshot is keyed by CID, the provider standard's own identifier, so it holds for exactly the
build it judged; a `.eth` entry records the CID it judged beside the name for the same reason.

**Orivon apps are marked from data, not detected.** The catalog says which sites are Orivon apps
and how (`native` or `port`, whether they `needsOrivon`, whether they are `published`, and the
`upstream` project of a port). A page cannot tell from outside whether another origin is an
Orivon app, so the mark is the directory's own claim and is kept honest by review of the catalog.

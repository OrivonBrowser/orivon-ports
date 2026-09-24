# `src/`: the executor

One CLI over a declarative recipe. Every command generalises something the one completed port
already did by hand.

| File | Job |
|---|---|
| `cli.ts` | Parse, dispatch, help |
| `recipe.ts` | The recipe schema, its validation, and command-token expansion |
| `apps.ts` | Finding apps on disk and loading their recipes |
| `paths.ts` | The only file that knows the repository layout |
| `fetch.ts` | Clone at the pinned commit, and prove the checkout landed there |
| `build.ts` | Run the app's own install and build |
| `prepare.ts` | Manifest, discovery hint, bridge, extra files — into the served tree, then the declaration |
| `declare.ts` | Declaring a prepared tree: the manifest's generated `assets` list and `.well-known/orivon-ddoc.json` |
| `bundle-hash.ts` | The Orivon bundle hash, its path rules and its caps, computed as the client computes them |
| `serve.ts` | A plain static file server |
| `names.ts` | Turns every recipe's fake `.eth` name into a name→port map and a PAC |
| `portable.ts` | Refusing to prepare an app that only one host could serve |
| `state.ts` | What `out/<app>/` holds, so work is not redone |
| `lock.ts` | One run at a time per source tree |
| `exec.ts` | Running a recipe's shell commands |
| `recon.ts` | Measuring somebody's app before committing to porting it, and writing its member list out as a declaration |
| `bridge/` | The bridge kit: the member declaration, the behaviour catalog, and the composer ([its own README](bridge/README.md)) |
| `build/` | `webpack-kit.cjs`, what an app's build wrapper calls instead of repeating itself |
| `testing/` | `bridge-harness.ts`: one realm per test, running the composed bridge |
| `scaffold.ts` | `new <app>`, from `templates/` |
| `doctor.ts` | Preflight |

## Design notes

**The doctype stays first.** `injectHint` and `injectBridge` insert after the document's own
opening when there is no `<head>` to insert into, never in front of it. A doctype that is not the
first thing in the document puts the page in quirks mode, and the result is a port whose layout is
quietly wrong with nothing logged anywhere. The same functions match `<head` with a word boundary,
because `<header>` starts with those five characters and injecting the bridge into the body would
run it after the app's own bundle rather than before it -- the one ordering the bridge exists to
guarantee.


**`fetch`, `build` and `prepare` take their directories as an argument rather than deriving
them from the app id.** `paths.ts` is then the single place that knows where anything lives, and
the three functions that do the real work are testable against a temporary directory instead of
writing into the repository's own `out/`.

**`prepare` clears the served tree before copying into it.** An incremental copy leaves an asset
from the previous build behind, and a stale file that nothing regenerates is served as if it
were current — a failure that survives a rebuild and looks like a code bug.

**`fetch` re-reads `HEAD` after checking out and fails if it is not the pinned commit.** The
pin is the whole reason a port is repeatable; a checkout that silently landed elsewhere produces
a build nobody can reproduce, and the difference is invisible until the port breaks against a
release nobody chose.

**The port lives in the recipe, not in the executor.** One origin per app is a permission
boundary rather than a convenience: a grant attaches to the URL, so a port that moved between
runs would silently drop its grant, and two apps sharing one would share permissions.

**`exec.ts` runs third-party build scripts with the user's privileges, and there is no way
around that.** Building an app means running its toolchain. What the executor can do is make the
input deterministic, which is why `upstream.ref` must be a commit. `SECURITY.md` states this
rather than leaving it implied.

**`serve.ts` resolves a request path with normalize-then-compare, including the separator.**
`startsWith(root)` alone accepts `/srv/app-secrets` for a root of `/srv/app`. The test file
carries the cases, including the ones that are *not* traversals, so nobody "hardens" it into
rejecting ordinary filenames.

**`serve.ts` is deliberately no more capable than an IPFS gateway.** A prepared app has to run
on whatever static host it is put behind, and the only way to keep that true is for the
development server to be the weakest of them: it derives a `Content-Type` from the file's name,
sets nothing else, and rewrites no bytes. A convenience here — decompressing on the fly, or
setting a `Content-Encoding` the file's name implies — is a dependency a port cannot take with
it, and it fails on the host as a blank page rather than here as a test. `portable.ts` enforces
the same line from the other side: `prepare` refuses an output holding brotli, gzip or zstd
bytes, detected by decoding them rather than by reading the extension, because a file *named*
`.br` that holds plain JSON is exactly the shape that travels.

**`prepare` writes relative URLs, resolved from the entry document.** The bridge `<script>` and
the manifest `<link>` are the only URLs this repository puts into somebody else's HTML, and a
root-absolute one works at a host's root and nowhere else -- under `/ipfs/<cid>/` it leaves the
mount point behind and 404s, taking the app with it, since the bridge has to be there before the
app's first line runs. The shell reads the hint through the DOM's resolved `.href`, so a relative
hint reaches it already absolute. What the app's own build emits is the app's business; `prepare`
is answerable for its own additions.

**`prepare` generates the manifest's `assets` list and the bundle hash from the finished tree,
last.** The Orivon client fetches the entry plus exactly what `assets` names, hashes each file,
and compares the root with the one in `.well-known/orivon-ddoc.json`. A file the list leaves out
is a file the app requests and the client never pinned, so the list is derived from the tree
rather than written by hand, and `check:manifest` refuses a committed manifest that carries one.
`declare.ts` runs after every other write in `prepare`, because a file written later is served
undeclared. `hash --check` recomputes both files and fails on a byte of difference, which is how
a tree edited after preparing is caught before a host serves it.

**The ddoc file is not a leaf, and the manifest is.** A file cannot hold the hash of a tree that
contains it. The manifest is hashed as the bytes served, which is why `assets` is written into it
before the hash is computed and why its formatting is the tool's, not the committed file's.

**A leaf's path is the URL path the client requests it at, and nothing here encodes a name by
hand.** The client refuses a path in any spelling but the one its URL parser produces, and it
never repairs one. So `canonicalPathOf` escapes only `%`, `?` and `#`, the three a parser reads
as syntax rather than as part of a name, and leaves the rest to `new URL(...).pathname`:
`encodeURIComponent` would turn `logo@2x.png` into `/logo%402x.png`, which the client refuses.
The result must decode back to the file's own name, because the parser drops tabs and newlines,
trims a trailing space and turns `\` into `/` without complaint, and a name that does not survive
is served under a different one. `assets` holds the same encoded form: a raw `x#y.js` resolves to
`/x` on the client. The path rules, the collision key and the caps are orivon-mvp's
(`docs/architecture/bundle-hash.md` there), mirrored rule for rule and pinned by its frozen
vectors, since a tree the client hashes differently is a tree it refuses. They include rules for
hazards Linux does not have (Windows device names, trailing dots, names differing only in case)
because a bundle has one identity on every platform or none.

**The ddoc file is a same-host anchor: it proves consistency, not authorship.** It is served by
the same host as the files it describes, so it catches a tree that changed after it was
declared, a truncated upload, or two builds mixed mid-deploy, and it cannot catch a host that
rewrites a file and the ddoc together. An anchor off the host is the Orivon client's concern,
not this repository's.

**The single-page-app fallback is the one thing `serve.ts` does that a gateway will not.** An
extensionless path with no file behind it gets the entry document, which is ordinary SPA hosting
and costs nothing for a hash-routed app. A history-routed port needs the host told separately —
on IPFS, a `_redirects` file in the output, honoured by Kubo on subdomain and DNSLink gateways
and not on path gateways. No port needs this yet; the first one that does should emit that file
from its build rather than leaning on this server.

**A recipe's `eth` name is allocated once and written down, the same as its port, and for the
same reason.** `scaffold.ts` derives it from the id at scaffold time rather than computing it at
runtime, because a name that moved would silently drop whatever session grant was scoped to it —
identical to the port's own rationale two notes above. It is a field on the recipe rather than
derived purely from `id` at every call site so a port's name can differ from its directory, the
way the vision docs' `mastodon.eth` would for a port whose id is `whalebird`.

**`serve.ts`'s Host guard is a misconfiguration check, not a defense against a local attacker.**
Anything already running on the machine can open `127.0.0.1:<port>` directly and claim any Host
it likes; nothing about loopback stops that, with or without this guard. What it stops is a
resolver entry or a generated PAC line that points the WRONG name at this port — `asgardex.eth`
proxied to FreeTube's own server would otherwise serve FreeTube's bytes under ASGARDEX's origin,
which is the one-origin-per-app boundary above being crossed by a data-entry mistake rather than
an attack. 421, not 404, because the request reached the wrong server, not a missing path — and
the body names neither the Host it received nor the app it hit, so a probe learns nothing from
which one it got.

**The `.eth` name is deliberately unpersistable, and that is not a bug to fix later.** It is
asserted by a file in this repository and proves nothing about who controls it, so the Orivon
shell's own origin policy refuses to write ANY plain-`http` grant to disk regardless of host —
session-scoped, re-prompted every launch. Serving `.eth` over TLS to "fix" this would defeat the
one property `serve.ts` is required to keep: no more capable than the static host a port has to
survive. See the app's own README for what a person granting it actually sees.

**`names.ts` hands back both a PAC and a plain name→port map, though only one is verified.**
Whether the shell steers by `--proxy-pac-url` or by `--host-resolver-rules` is a question about
Chromium's own behaviour, not this repository's -- and against a real Electron 44 window, a
`file://` `--proxy-pac-url` did not take effect at all, silently falling through to ordinary DNS,
while `--host-resolver-rules` built from the plain map reached the default session and a
`session.fromPartition` one identically. The PAC generator stays: it is fully tested and correct
on its own terms, and a different Electron build or a future consumer may still want it.

**A recipe is a port or a site, and the type says which.** `Recipe` is a union of `PortRecipe`
and `SiteRecipe`, so `fetch` and `build`, which only a port can reach, take a `PortRecipe` and
cannot be handed a site by mistake. A site skips both and is prepared on every run: it has no ref
to key freshness on, and copying a few files costs less than deciding whether they are stale.
`prepare` serves both shapes, and the one line in it that differs is where the files come from.

**`recipe.ts` rejects an unknown field instead of ignoring it.** A typo in a field name is
otherwise a setting that silently does nothing, discovered much later as behaviour that will not
turn on.

**The build kit is CommonJS, alone in a repository that is otherwise ESM.** `webpack-kit.cjs` is
required by an app's own `*.config.cjs`, which webpack loads from inside the app's clone. Node
resolves a relative `require` against the requiring file, so the wrapper reaches this repository
from any working directory — and nothing else would: a bare specifier would resolve into the
clone's `node_modules`.

**`retargetOutput` throws on a copy pattern that still writes outside the output directory,
rather than reporting a count.** The trap it exists for produced a build that silently wrote into
another target's `dist/`, so the honest invariant is "a port writes nowhere but its own output",
which a new port can hold without knowing which patterns upstream hardcoded. A count would need a
wrapper author to assert something they have not thought of yet.

**The test harness composes rather than reading a bridge file.** A port's tests then drive the
exact bytes the browser is served, including the generated groups — a member that works when it
is called directly and not when it is installed is a member that has not been tested.

**The `hooks` seam has no user yet.** It is the one escape hatch for HTML surgery the recipe
fields cannot express, and it exists because the alternative — a port blocked until someone
changes `src/` — is worse than a tested seam with no consumer. Delete it if a second and third
port never reach for it.

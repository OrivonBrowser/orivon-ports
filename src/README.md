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
| `prepare.ts` | Manifest, discovery hint, bridge, extra files — into the served tree |
| `serve.ts` | A plain static file server |
| `state.ts` | What `out/<app>/` holds, so work is not redone |
| `lock.ts` | One run at a time per source tree |
| `exec.ts` | Running a recipe's shell commands |
| `recon.ts` | Measuring somebody's app before committing to porting it |
| `scaffold.ts` | `new <app>`, from `templates/` |
| `doctor.ts` | Preflight |

## Design notes

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

**`recipe.ts` rejects an unknown field instead of ignoring it.** A typo in a field name is
otherwise a setting that silently does nothing, discovered much later as behaviour that will not
turn on.

**The `hooks` seam has no user yet.** It is the one escape hatch for HTML surgery the recipe
fields cannot express, and it exists because the alternative — a port blocked until someone
changes `src/` — is worse than a tested seam with no consumer. Delete it if a second and third
port never reach for it.

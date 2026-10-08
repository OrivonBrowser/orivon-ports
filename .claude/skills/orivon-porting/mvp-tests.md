# Which orivon-mvp tests a port needs

A port breaks in two ways nobody here would see: upstream changes under a new pin, or Orivon changes
under the same pin. The first is caught by rebuilding and sweeping ([maintain.md](maintain.md)).
The second is caught only if Orivon's own CI runs a test of each behaviour the port relies on, and
that is what this file decides. The guide's Step 7 is the rule; this is how to apply it.

Orivon keeps those tests as a catalogue: `../orivon-mvp/test/app-behaviours/catalogue.md`, one row
per behaviour an app counts on, each tied to an end-to-end spec titled `[app:<id>]`. Any change to
Orivon's broker, contracts, preload, loader or shim runs every spec the catalogue names, so a row is
a promise CI keeps. `../orivon-mvp/test/app-behaviours/README.md` is how a row and its spec are
written. Read it before writing one.

## 1. List what the port relies on

One line each, stated as something a test could see, never as the app's feature: "data written to
IndexedDB is there after a restart", not "settings persist". Take them from:

- **The manifest.** Each capability kind it declares, and each pattern that matters: a `*:*`
  that must reach a reserved port, a loopback listener, a quota, `crossOriginIsolated`.
- **The bridge roster.** Each member that calls `orivon.*` relies on what that call does, including
  how it fails: the error code a refusal carries, a write that must survive a restart.
- **The page platform the app's main job uses.** Storage across restarts, service workers, WASM
  under the served CSP, Web Locks, `window.open`, sandboxed frames, clipboard writes, media, the tab
  icon. The sweep's request log and console show what is used ([verify.md](verify.md)).
- **What the app's README says it needs from orivon-mvp**, and every past Orivon fix the app needed.

## 2. Put each line in one of five places

| What the line is | Where it goes |
|---|---|
| A proven catalogue row already states it | Name the row's id in the app's README section What it needs from orivon-mvp, and add this port to that row's Ports column |
| A row states it but says `not covered: <reason>` | A generic spec that proves it; this port is the reason it is now due. Rows ports keep hitting this way: redirects and `FormData` through routed fetch, user-picked files and folders, a sandboxed frame running a served script, clearing site data |
| No row states it | A new generic row and spec |
| The bridge's own logic: defaults, envelopes, what a member answers | A test here, in `apps/<id>/bridge/*.test.ts`, named after the behaviour. It runs in this repository's CI |
| Upstream's behaviour, or a third party's | Nothing. Record it in the app's README |

A behaviour that only the real app can show, because no small page can reach it (a token minted
inside a third party's script, upstream's real server in a Worker), is the one case for a spec that
runs the real port: `../orivon-mvp/test/ported-apps/`. Those specs need a ports checkout, so Orivon's
CI skips them; they are what you run by hand after an upstream bump or an Orivon change in that
area. Add one only when the app's main job depends on a path nothing generic proves, and still give
the parts generic rows.

## 3. Who writes the mvp half

Adding a port to a Ports column, a new row and its spec, or a spec for a `not covered` row are
changes to orivon-mvp, under its rules (Rule 20: the spec names no app and copies no app code; the
app may appear in a code comment only).

- **Session started in orivon-mvp, or the owner asked for both repositories**: make the change in an
  mvp worktree off `origin/main`, as its own pull request, and merge it when green. A row and spec
  with no `src/` change is a fast-lane change there (Rule 18).
- **Session started here**: hand the owner a prompt for an mvp session (`CLAUDE.md` Rule 9), in this
  shape:

```text
In orivon-mvp, a port relies on a behaviour the app-behaviour catalogue does not prove.
Behaviour: <one generic, observable sentence>.
Relied on by: orivon-ports apps/<id>/<file>:<line> (<what it does with it>).
Today: <no row | row `<id>` is not covered: <reason> | a proven row, Ports column lacks <port>>.
Ask: a catalogue row and an e2e spec that proves it through the real shell, generic, naming no
app and copying none of its code (test/app-behaviours/README.md section Adding a row), shown to
fail with the behaviour broken. Add <port> to the row's Ports column.
```

Either way the port's README names the row id once it exists, so a red `[app:<id>]` test is
recognised as this port's breakage. Only a public port is named in a Ports column; the catalogue
names ports only where Orivon's compatibility pages already do.

## 4. Mistakes that cost a review round

- A spec named after the app, or a title that says what the app does. Name the behaviour.
- A unit test offered as the proof. A row needs an end-to-end spec; a unit test may stand beside it.
- An `it` title built with a template literal, or marked `.skip`, `.only`, `.todo` or `.runIf`. The
  guard refuses them; the one allowed modifier is `skipIf(!ORDINARY_BUILD)`, and then the spec must
  be in the `e2e-ordinary` job of `../orivon-mvp/.github/workflows/ci.yml`.
- A test never seen failing. Break the behaviour, watch it go red, restore it, say so in the PR.
- A rewritten row sentence with no `### Changed for apps` line in the mvp `CHANGELOG.md`. A new row,
  or a new port in a Ports column, needs none.
- A spec that waits on the clock. Wait on state; several behaviours share one launch.
- Rows for every bridge member. A row is a behaviour of Orivon an app counts on, not a member list.

`npm run check:app-behaviours`, `npm run check:contracts-surface` and `npm run check:test-paths` in
orivon-mvp catch the mechanical half. The spec itself runs through the heavy wrapper and
`../orivon-mvp/scripts/run-headless.mjs`, as that README's Commands section shows.

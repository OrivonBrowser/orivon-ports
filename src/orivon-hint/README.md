# `src/orivon-hint/`: the Orivon hint

What a visitor whose browser is not Orivon is told about an app this repository prepares. Which of
three things shows depends on the app's **tier**, which its recipe declares
([`hint` in `docs/recipe-format.md`](../../docs/recipe-format.md)), and on where it is opened.

| Where | Tier 1: works in any browser | Tier 2: needs Orivon to work at all |
|---|---|---|
| Inside Orivon | Nothing | Nothing |
| Another browser | A small **pill** in the corner, which can be closed | A **landing** shown instead of the app |

Inside Orivon the hint is silent, except for an app whose recipe sets `hint.notice`: that line shows
there, in the same kind of pill, with a close button and no download link. It is for a limit a person
should know before using the app.

| File | Job |
|---|---|
| `hint.js` | Decides what shows, then builds it in a shadow root |
| `hint.css` | The look of the landing and the pill: white in a light theme, black in a dark one |
| `logo.png` | The Orivon logo, the same file as orivon-mvp's `src/renderer/assets/logo.png` |
| `hint.test.ts` | Runs the served `hint.js` against a fake page: every decision, and what is built |
| `hint-browser.test.ts` | Runs prepared pages in a real Chromium: the landing, the pill, Orivon |
| `hint-recipes.test.ts` | Every recipe has a hint, and the issue form lists every app |

`prepare` copies the three served files to `orivon/hint/` in every served tree, ports and sites
alike, and adds one `<script src="orivon/hint/hint.js" ...>` carrying the app's data as `data-*`
attributes (an attribute passes any Content Security Policy; an inline script does not). The files
are then declared with the rest of the tree, so the bundle hash covers them.

## The three things

**The landing (tier 2, outside Orivon).** A page that replaces the app: the app's name, "`<App>` runs
inside Orivon, an open-source browser that provides the desktop parts this app needs.", the recipe's
extra line if it has one, **Get Orivon** (`https://download.orivonstack.eth.limo/?app=<id>`),
**Official `<App>` downloads** (the recipe's `officialUrl`), "A community build by Orivon, not the
official `<App>`.", and **Report a problem with this build**. **Continue anyway** and the close
control (and Escape) go on to the app: they remember the choice in `sessionStorage` and reload, and
the app then starts as in any browser, with a pill saying it may not work. Where storage is blocked,
a reload could not tell the choice, so the landing offers no way on and keeps only its links.

**The pill (tier 1, and tier 2 after Continue anyway).** A card in the bottom-right corner with one
sentence, the community-build line, **Get Orivon**, the report link and a close button. Closing it,
or Escape, keeps it closed for the tab's session. It never takes focus from the page.

**The notice (inside Orivon, when the recipe sets `hint.notice`).** The pill with the recipe's line,
the report link and a close button.

The community-build line and the official link appear only for a port. A page written in this
repository has no official build to name, so it has neither.

`OPEN_IN_ORIVON` at the top of `hint.js` is `false`. While it is, no **Open in Orivon** button is
built; set it to `true` once a released Orivon handles `orivon:` links and the button appears on the
landing as `orivon:open?u=<the recipe's .eth name>`. It uses the recipe's `eth` rather than the app
id, because the two differ (`the-lounge` is `thelounge.orivonstack.eth`).

The report link opens the issue form
([`.github/ISSUE_TEMPLATE/port-problem.yml`](../../.github/ISSUE_TEMPLATE/port-problem.yml)) with the app
and a title filled in. GitHub fills a dropdown from the query parameter named after the field's
`id`, matched against an option's label, so the link carries the app's name (`app=The%20Lounge`),
and `hint-recipes.test.ts` fails when a name is missing from the form.

## Turning it off

`orivon-port build <app> --no-orivon-hint` and `orivon-port run <app> --no-orivon-hint` prepare
the tree without it. `out/<app>/.orivon-state.json` records which way the tree was prepared, so
switching between the two prepares the tree again from the build output in the clone; it never
rebuilds the app. `serve` changes nothing and serves the tree as it was last prepared.

## When it decides

- **Not inside Orivon.** Orivon exposes `window.orivon`, with a numeric `version`, in every tab's
  main frame before the page's own scripts run. The hint checks for that shape, which is also what
  `apps/explore/site/orivon.js` checks.
- **Only in the top frame.** An app embedded in somebody else's page shows nothing.
- **Once per tab session.** `sessionStorage['orivon-hint:state']` is `continue` (tier 2 went on to the
  app) or `closed`. A new tab, or a browser restart, starts again. Where storage throws, the hint
  shows on every load.
- **No request to anyone else, no tracking.** Its only requests are its own three files, from the
  app's own origin. Its links open in a new tab with `noopener noreferrer`.

## Design notes

**A tier 2 app has not started when its landing shows.** The script is the first in `<head>` (after
the page's `<base>`, because a relative URL ahead of it resolves against the document), synchronous,
ahead of the bridge: `injectOrivonHint` is called after `injectBridge` for that reason. It writes `<plaintext>` into the parser's input with `document.write`, which makes the
parser read the rest of the document as one run of text. No script, inline or external, parsed or
`defer`red or `async` or a module, is ever reached, the document still ends normally and fires its
load events, and the text is removed at `DOMContentLoaded` so nothing reads it out. A browser may
still start downloading the page's files before the script has run (its preload scanner reads ahead
of the parser); they are fetched and never run. `<!--` would end at the first `-->` in the app's own
markup, and `window.stop()` leaves the page unpainted and its load event unfired in Chromium: it is
the fallback for a page that refuses `document.write` (a Trusted Types policy), where the app is
still kept from starting. Making the entry page a small loader instead would mean rewriting the
app's own markup and every URL in it, which `prepare` never does. `hint-browser.test.ts` checks the
claim against a page holding every kind of script, an inline comment ending in `-->`, and hostile
page CSS.

**Three files rather than one script with everything inlined.** An app's Content Security
Policy decides what runs in its page, and Element's, for one, allows no inline script.
A same-origin script, stylesheet and image pass any policy that lets the app load its own
files; an inline `<style>` or a `data:` image needs the policy to allow it, and many do not. For
the same reason the hint is built with `createElement` and `textContent`, never `innerHTML`,
which a Trusted Types policy refuses.

**A shadow root, and `!important` on the host.** The app's stylesheets cannot reach inside a
shadow root, so the hint looks the same over every app. The host element itself is in the
page and the page's rules still match it; an `!important` declaration in a shadow root's `:host`
rule outranks the page's own `!important` one. `all: initial` stops the page's inherited font and
colour from leaking in.

**On `<html>`, beside `<body>`.** A framework that replaces its body's children would take a
hint appended to `<body>` with them.

**Nothing renders before the stylesheet loads.** The shadow root holds only the `<link>` until
its `load` event, so an unstyled pill never flashes at the bottom of the page, and a stylesheet
that fails to load leaves no pill at all. The landing is all there is to see, so it shows without
styles rather than leave a blank page.

**Every URL is resolved from the script's own.** `document.currentScript.src` is absolute
wherever the tree is mounted, an IPFS path gateway's `/ipfs/<cid>/` included, which is the
same rule `prepare` follows for the URLs it writes (`../README.md`).

**Tier 1 is `defer`red; tier 2 is not.** A tier 1 app starts as it always did and the pill waits for
the document like any page script. A tier 2 script has to run before the app can.

## Running the browser test

`hint-browser.test.ts` uses the Chromium that an orivon-mvp checkout's Playwright already installed:
`ORIVON_MVP_ROOT` names the checkout, `../orivon-mvp` by default. Without it the file skips, and
`npm test` still passes. It opens no window.

```bash
npx vitest run src/orivon-hint/hint-browser.test.ts
```

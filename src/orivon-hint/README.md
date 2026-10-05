# `src/orivon-hint/`: the Orivon hint

A panel in the bottom-right corner of every app this repository prepares. It tells a visitor
whose browser is not Orivon that some of the app will not work there, and offers two buttons:
**Download Orivon**, which opens `https://download.orivonstack.eth.limo` in a new tab, and
**Maybe later**. It has no close button. Inside Orivon it never appears.

| File | Job |
|---|---|
| `hint.js` | Decides whether to show, then builds the panel in a shadow root |
| `hint.css` | The panel's look: white in a light theme, black in a dark one |
| `logo.png` | The Orivon logo, the same file as orivon-mvp's `src/renderer/assets/logo.png` |
| `hint.test.ts` | Runs the served `hint.js` against a fake page |

`prepare` copies the three served files to `orivon/hint/` in every served tree, ports and sites
alike, and adds `<script src="orivon/hint/hint.js" defer>` before `</head>`. The files are then
declared with the rest of the tree, so the bundle hash covers them.

## Turning it off

`orivon-port build <app> --no-orivon-hint` and `orivon-port run <app> --no-orivon-hint` prepare
the tree without it. `out/<app>/.orivon-state.json` records which way the tree was prepared, so
switching between the two prepares the tree again from the build output in the clone; it never
rebuilds the app. `serve` changes nothing and serves the tree as it was last prepared.

## When it shows

- **Not inside Orivon.** Orivon exposes `window.orivon`, with a numeric `version`, in every tab's
  main frame before the page's own scripts run. The panel checks for that shape, which is also
  what `apps/explore/site/orivon.js` checks.
- **Only in the top frame.** An app embedded in somebody else's page shows nothing.
- **Not again in the same tab session after either button.** Both write `orivon-hint:later` to
  `sessionStorage`. A new tab, or a browser restart, shows it again. Where storage throws, the
  panel shows on every load.

## Design notes

**Three files rather than one script with everything inlined.** An app's Content Security
Policy decides what runs in its page, and Element's, for one, allows no inline script.
A same-origin script, stylesheet and image pass any policy that lets the app load its own
files; an inline `<style>` or a `data:` image needs the policy to allow it, and many do not. For
the same reason the panel is built with `createElement` and `textContent`, never `innerHTML`,
which a Trusted Types policy refuses.

**A shadow root, and `!important` on the host.** The app's stylesheets cannot reach inside a
shadow root, so the panel looks the same over every app. The host element itself is in the
page and the page's rules still match it, and a page rule outranks a `:host` rule that is not
`!important`. `all: initial` stops the page's inherited font and colour from leaking in.

**On `<html>`, beside `<body>`.** A framework that replaces its body's children would take a
panel appended to `<body>` with them.

**Nothing renders before the stylesheet loads.** The shadow root holds only the `<link>` until
its `load` event, so an unstyled panel never flashes at the bottom of the page, and a stylesheet
that fails to load leaves no panel at all.

**Every URL is resolved from the script's own.** `document.currentScript.src` is absolute
wherever the tree is mounted, an IPFS path gateway's `/ipfs/<cid>/` included, which is the
same rule `prepare` follows for the URLs it writes (`../README.md`).

**`defer`, after the bridge.** The bridge must run before the app's first line and is the first
script in `<head>`; the panel waits for the document like any page script and delays nothing.

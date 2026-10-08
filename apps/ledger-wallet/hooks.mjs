// Three changes to Ledger Wallet's built HTML, all idempotent.
//
// It declares no favicon: the desktop app's icon lives in
// apps/ledger-live-desktop/build/icons, outside what the renderer build emits,
// and `recipe.json`'s extraFiles copies it into the served tree. The link is
// relative to the entry document so the tree survives being mounted under a
// prefix (an IPFS path gateway).
//
// It also carries `<script>var parcelRequire</script>`, a bundler workaround
// that an app tab's content policy refuses to run (a console error on every
// load). The bridge declares the same global, so the script goes.
//
// Third, the renderer's <script>. The bridge writes the identical tag once
// the page has `process` (bridge/ledger-wallet.js, the renderer gate), so a static
// copy would load the renderer a second time, or with no `process` at all. A
// comment stays where the tag was; when the tag is neither there nor replaced, the
// build fails rather than ship a page whose gate does nothing.
const RENDERER = '<script defer src="./renderer.bundle.js"></script>'
const GATED = '<!-- the bridge adds the renderer script once the page has process -->'
const LINK = '<link rel="icon" type="image/png" href="orivon/ledger-wallet-icon.png">'
const PARCEL = '<script>var parcelRequire</script>'

export function transformHtml (html) {
  if (!html.includes(RENDERER) && !html.includes(GATED)) throw new Error(`index.html has no ${RENDERER}; the renderer gate in bridge/ledger-wallet.js needs it`)
  const without = html.replace(PARCEL, '').replace(RENDERER, GATED)
  if (without.includes('rel="icon"')) return without
  return without.replace('</head>', `${LINK}</head>`)
}

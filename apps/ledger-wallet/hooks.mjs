// Two changes to Ledger Wallet's built HTML, both idempotent.
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
const LINK = '<link rel="icon" type="image/png" href="orivon/ledger-wallet-icon.png">'
const PARCEL = '<script>var parcelRequire</script>'

export function transformHtml (html) {
  const without = html.replace(PARCEL, '')
  if (without.includes('rel="icon"')) return without
  return without.replace('</head>', `${LINK}</head>`)
}

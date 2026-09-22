// ASGARDEX's renderer declares its favicon at a root-absolute `/favicon.ico`.
// That file is Electron's stock placeholder, not ASGARDEX's mark, and the Vite
// build does not emit `public/` into `build/renderer` anyway, so the served tree
// has no such file -- a 404, and a browser tab falls back to a globe. A
// root-absolute URL also escapes an IPFS path-gateway mount, which every other
// URL this port serves is kept relative to avoid. Point the existing link at the
// app's own icon, which `recipe.json` copies out of `resources/icons/` (the
// branding tree, outside what the renderer build emits) as a PNG under Orivon's
// 32 KB favicon cap.
const FROM = 'href="/favicon.ico"'
const TO = 'href="orivon/asgardex-icon.png"'

export function transformHtml (html) {
  if (!html.includes(FROM)) return html
  return html.replace(FROM, TO)
}

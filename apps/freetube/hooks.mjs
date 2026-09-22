// FreeTube's Electron renderer is built with no favicon: upstream sets the
// window icon from main (`_icons/iconColor.png`), so `index.ejs` emits no
// `<link rel="icon">` and a browser tab falls back to a globe. Orivon's own
// favicon capture accepts bitmap formats only (`src/main/favicon.ts` excludes
// SVG), and upstream's PWA manifest points at an SVG, so the PNG the recipe
// copies out of the clone is what the page has to name.
const ICON = '<link rel="icon" type="image/png" href="orivon/freetube-icon.png">'

export function transformHtml (html) {
  if (html.includes('rel="icon"')) return html
  return html.replace('</head>', `  ${ICON}\n</head>`)
}

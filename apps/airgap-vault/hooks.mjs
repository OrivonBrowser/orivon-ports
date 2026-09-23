// Upstream's Electron build target sets `--base-href=./`, because a real
// Electron app loads `index.html` via `file://` and every asset must resolve
// relative to wherever the app bundle happens to sit. This app also uses
// Angular's history routing (`PathLocationStrategy`, no `useHash`), and boots
// straight into a redirect to `/tabs/tab-secrets` -- so a reload or a
// bookmark of that URL resolves `main.js` under `/tabs/` instead of the
// document root, and 404s. Each app here owns one origin at its root, so
// there is no relative mount to preserve: rewrite the base back to `/`.
const FROM = '<base href="./">'
const TO = '<base href="/">'

export function transformHtml (html) {
  if (html.includes(TO)) return html
  if (!html.includes(FROM)) {
    throw new Error(`airgap-vault hooks.mjs: expected to find ${JSON.stringify(FROM)} in index.html`)
  }
  return html.replace(FROM, TO)
}

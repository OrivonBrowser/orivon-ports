// The renderer's HTML needs two things upstream's build did not write, both before the renderer's
// first module runs:
//
//   - `<base href="/">`. The renderer is history-routed, so a tab can be reloaded at
//     `/accounts/<id>`, and every URL `prepare` injects (the hint, the bridge, the manifest link) and
//     the page's own `install/` and `server.mjs` are relative to the entry document: under a base of
//     the document's own directory they would resolve to `/accounts/orivon/...` and miss. The
//     element goes before `<head>`: the parser makes it the head's first child, so it precedes
//     the scripts `prepare` writes after `<head>`, and the real `<head>` tag (which carries no
//     attributes in upstream's page) is then ignored.
//   - the page's side of the backend, a classic script. `prepare` adds the bridge in front of it.
//
// Idempotent: `prepare` may run twice.

const BASE = '<base href="/">'
const SCRIPT = '<script src="orivon/actual-backend.js"></script>'

export function transformHtml (html) {
  const head = /<head\b[^>]*>/i.exec(html)
  if (head === null) throw new Error('hooks.mjs: the renderer\'s index.html has no <head>')
  if (head[0].toLowerCase() !== '<head>') throw new Error(`hooks.mjs: the renderer's <head> carries attributes (${head[0]}), which the base element placed before it would drop`)
  let out = html
  if (!out.includes(SCRIPT)) out = `${out.slice(0, head.index + head[0].length)}${SCRIPT}${out.slice(head.index + head[0].length)}`
  if (!out.includes(BASE)) out = `${out.slice(0, head.index)}${BASE}${out.slice(head.index)}`
  return out
}

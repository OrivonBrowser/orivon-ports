// Two edits to the built index.html, and the one file the second needs.
//
// The icon: upstream sets the window icon from main (`_icons/iconColor.png`),
// so `index.ejs` emits no `<link rel="icon">` and a browser tab falls back to a
// globe. Orivon's own favicon capture accepts bitmap formats only
// (`src/main/favicon.ts` excludes SVG), and upstream's PWA manifest points at
// an SVG, so the PNG the recipe copies out of the clone is what the page has
// to name.
//
// The sigFrame: see ./README.md, "The sigFrame".
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const ICON = '<link rel="icon" type="image/png" href="orivon/freetube-icon.png">'

export const SIG_FRAME_FILE = 'orivon/sig-frame.js'

// Runs before upstream's script, and throws to stop it: only a sandboxed
// frame without allow-same-origin has the opaque origin 'null', and only a
// child has a parent other than itself. A script tag injected into the app's
// own document, or into any same-origin frame, gets neither.
const GUARD = "if (self.origin !== 'null' || window.parent === window) throw new Error('sig-frame: this script runs only inside the sandboxed sigFrame')\n"

const IFRAME = /<iframe\b[^>]*\bid="sigFrame"[^>]*>/
const DATA_PREFIX = 'data:text/html,'
const INLINE_DOCUMENT = /^<!doctype html><script>([\s\S]*)<\/script>$/i

/** The characters `index.ejs`'s `<%= %>` escapes, read back the way a browser reads an attribute. */
function unescapeAttribute (value) {
  return value
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function removeAttribute (tag, name) {
  return tag.replace(new RegExp(`\\s${name}="[^"]*"`), '')
}

/**
 * Upstream renders `<iframe id="sigFrame" src="data:text/html,<script>...</script>"
 * csp="... 'sha512-...' ...">`. The app's CSP has no 'unsafe-inline' and a data:
 * frame inherits it, so that inline script never runs and every n/sig
 * decipher hangs. The script moves to `orivon/sig-frame.js` byte for byte,
 * behind a guard, and the frame loses the two attributes that named the
 * inline form. The bridge sets them again at DOMContentLoaded, from the
 * origin the page is served from, which no build can know.
 */
async function extractSigFrame (html, dirs) {
  const match = html.match(IFRAME)
  if (match === null) {
    throw new Error('freetube hooks: no <iframe id="sigFrame"> in the built index.html -- the build no longer renders upstream\'s sigFrame (IS_ELECTRON), and the Local API cannot decipher without it')
  }
  const tag = match[0]
  const src = tag.match(/\ssrc="([^"]*)"/)
  // No src: this document was already rewritten.
  if (src === null) return html

  const value = unescapeAttribute(src[1] ?? '')
  if (!value.startsWith(DATA_PREFIX)) {
    throw new Error(`freetube hooks: the sigFrame's src is not a data:text/html URL (${value.slice(0, 40)}) -- upstream's sigFrameConfig changed shape`)
  }
  const inline = decodeURIComponent(value.slice(DATA_PREFIX.length)).match(INLINE_DOCUMENT)
  if (inline === null) {
    throw new Error('freetube hooks: the sigFrame document is not `<!doctype html><script>...</script>` -- upstream\'s sigFrameConfig changed shape')
  }

  const target = join(dirs.static, SIG_FRAME_FILE)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${GUARD}${inline[1]}\n`)

  return html.replace(tag, removeAttribute(removeAttribute(tag, 'src'), 'csp'))
}

export async function transformHtml (html, { dirs }) {
  let out = await extractSigFrame(html, dirs)
  if (!out.includes('rel="icon"')) out = out.replace('</head>', `  ${ICON}\n</head>`)
  return out
}

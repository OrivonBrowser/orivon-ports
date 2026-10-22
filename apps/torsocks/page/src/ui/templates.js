// The pages a visitor of a published onion service sees. They run no script and
// load nothing from elsewhere, so they work in Tor Browser's safest mode.
import { formatDate, humanSize } from './helpers.js'

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escapes text for element content and for double- or single-quoted attributes. */
export function escapeHtml (value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char])
}

// Links stay inside the service: a name that looks like a scheme or a
// protocol-relative URL is turned into a plain relative path.
function relativeHref (href) {
  const text = String(href ?? '')
  return /^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith('//') || text.startsWith('\\') ? `./${text.replace(/^[/\\]+/, '')}` : text
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; base-uri 'none'; form-action 'none'"

const STYLE = `
:root{color-scheme:dark;--bg:#07090c;--panel:#0d1117;--line:#1d2530;--text:#d7e0ea;--muted:#8895a5;--violet:#b4a0ff;--green:#3ee6a8}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);background-image:linear-gradient(rgba(255,255,255,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.02) 1px,transparent 1px);background-size:32px 32px;color:var(--text);font:17px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.page{max-width:44rem;margin:0 auto;padding:2.5rem 1rem 3rem}
.kicker{margin:0 0 .75rem;color:var(--green);font:600 .75rem/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase}
h1{margin:0 0 .5rem;font-size:clamp(1.6rem,6vw,2.4rem);line-height:1.2;letter-spacing:-.01em;overflow-wrap:anywhere}
.meta{margin:0 0 2rem;color:var(--muted);font:.85rem/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.note{margin:0 0 1.75rem;color:var(--muted);overflow-wrap:anywhere}
.prose{overflow-wrap:anywhere}
.prose h1,.prose h2,.prose h3{margin:2rem 0 .75rem;line-height:1.25}
.prose h1{font-size:1.6rem}.prose h2{font-size:1.35rem}.prose h3{font-size:1.15rem}
.prose p,.prose ul,.prose ol,.prose pre,.prose blockquote{margin:0 0 1.1rem}
.prose a,a{color:var(--violet);text-underline-offset:.2em}
.prose blockquote{padding:.1rem 1rem;border-left:3px solid var(--violet);color:var(--muted)}
.prose code{padding:.1em .35em;border:1px solid var(--line);border-radius:4px;background:var(--panel);font:.88em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.prose pre{overflow-x:auto;padding:1rem;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
.prose pre code{padding:0;border:0;background:none}
.prose img{max-width:100%;height:auto}
.prose hr{border:0;border-top:1px solid var(--line);margin:2rem 0}
figure{margin:0 0 1.5rem}
figure img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
figcaption{margin-top:.75rem;color:var(--muted);overflow-wrap:anywhere}
.button{display:inline-block;padding:.65rem 1.1rem;border:1px solid var(--violet);border-radius:8px;color:var(--violet);font:600 .9rem/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-decoration:none}
.button:hover,.button:focus-visible{background:var(--violet);color:#0b0714}
a:focus-visible{outline:2px solid var(--violet);outline-offset:3px}
.files{margin:0;padding:0;list-style:none;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
.files li{display:flex;gap:1rem;align-items:baseline;justify-content:space-between;padding:.85rem 1rem;border-top:1px solid var(--line)}
.files li:first-child{border-top:0}
.files a{min-width:0;overflow-wrap:anywhere;font-weight:500}
.size{flex:none;color:var(--muted);font:.8rem/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap}
.foot{display:flex;gap:.6rem;align-items:center;margin-top:3rem;padding-top:1.25rem;border-top:1px solid var(--line);color:var(--muted);font:.78rem/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.foot svg{flex:none}
`

const MARK = '<svg width="18" height="18" viewBox="0 0 32 32" fill="none" stroke-linecap="round" aria-hidden="true"><circle cx="16" cy="16" r="11" stroke="#9d7cff" stroke-width="3" stroke-dasharray="58 11" transform="rotate(209 16 16)"/><circle cx="16" cy="16" r="5" stroke="#3ee6a8" stroke-width="3" stroke-dasharray="26 5" transform="rotate(209 16 16)"/><path d="M3 16h13" stroke="#d7e0ea" stroke-width="2.5"/></svg>'

function shell (title, kicker, inner) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="page">
<p class="kicker">${escapeHtml(kicker)}</p>
${inner}
<p class="foot">${MARK}<span>Published over Tor with TorSocks</span></p>
</main>
</body>
</html>
`
}

function heading (title) {
  return escapeHtml(String(title ?? '').trim() || 'Untitled')
}

/** `bodyHtml` is inserted as it is: the Markdown renderer that made it escapes its input. */
export function articlePage ({ title, byline, date, bodyHtml }) {
  const day = formatDate(date)
  const parts = [String(byline ?? '').trim() ? escapeHtml(String(byline).trim()) : '', day ? `<time datetime="${day}">${day}</time>` : ''].filter(Boolean)
  const meta = parts.length ? `<p class="meta">${parts.join(' &middot; ')}</p>` : ''
  return shell(String(title ?? '').trim() || 'Untitled', 'Article', `<article>
<h1>${heading(title)}</h1>
${meta}
<div class="prose">
${bodyHtml ?? ''}
</div>
</article>`)
}

export function picturePage ({ title, note, image, alt }) {
  const src = escapeHtml(relativeHref(image))
  const text = String(alt ?? '').trim() || String(title ?? '').trim() || 'Picture'
  const caption = String(note ?? '').trim() ? `<figcaption>${escapeHtml(String(note).trim())}</figcaption>` : ''
  return shell(String(title ?? '').trim() || 'Untitled', 'Picture', `<h1>${heading(title)}</h1>
<figure>
<img src="${src}" alt="${escapeHtml(text)}">
${caption}
</figure>
<p><a class="button" href="${src}" download>Download original</a></p>`)
}

export function filesPage ({ title, note, files }) {
  const list = Array.isArray(files) ? files : []
  const total = list.reduce((sum, file) => sum + (Number(file.size) || 0), 0)
  const rows = list.map((file) => `<li><a href="${escapeHtml(relativeHref(file.href))}" download>${escapeHtml(file.name)}</a><span class="size">${escapeHtml(humanSize(file.size))}</span></li>`).join('\n')
  const summary = `${list.length} ${list.length === 1 ? 'file' : 'files'}, ${humanSize(total)}`
  const intro = String(note ?? '').trim() ? `<p class="note">${escapeHtml(String(note).trim())}</p>` : ''
  return shell(String(title ?? '').trim() || 'Untitled', 'Files', `<h1>${heading(title)}</h1>
<p class="meta">${escapeHtml(summary)}</p>
${intro}
${list.length ? `<ul class="files">\n${rows}\n</ul>` : '<p class="note">There are no files here.</p>'}`)
}

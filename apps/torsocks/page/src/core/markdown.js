// The Markdown an article is written in, turned into the HTML its page
// shows. Every character of the text is escaped before any markup is
// recognised, so the only tags in the output are the ones made here. No
// images: an article page loads nothing from outside its own onion address,
// and a picture belongs in a Picture publication.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeText (text) {
  return String(text).replace(/[&<>"']/g, (c) => ESCAPES[c])
}

/** A link target an article may use: the web, mail, this site's own paths and anchors. */
export function safeHref (raw) {
  const href = raw.trim()
  if (/^(https?:|mailto:)/i.test(href)) return href
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null
  if (/^\/\//.test(href)) return null
  return href
}

const PLACEHOLDER = '\u0000'

/** Inline markup on one block's text: code, links, bold, italic. */
export function inline (text) {
  const kept = []
  const keep = (html) => `${PLACEHOLDER}${kept.push(html) - 1}${PLACEHOLDER}`
  let out = String(text).replaceAll(PLACEHOLDER, '').replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${escapeText(code)}</code>`))
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
    const safe = safeHref(href)
    if (safe === null) return whole
    return keep(`<a href="${escapeText(safe)}" rel="noreferrer">${formatting(escapeText(label))}</a>`)
  })
  out = formatting(escapeText(out))
  return out.replace(new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'), (_, i) => kept[Number(i)])
}

function formatting (escaped) {
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const FENCE = /^\s*```/

/** The article's body as HTML. Headings start at h2: the page's title is its h1. */
export function renderMarkdown (source) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') { i++; continue }
    if (FENCE.test(line)) {
      const code = []
      i++
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++])
      i++
      blocks.push(`<pre><code>${escapeText(code.join('\n'))}</code></pre>`)
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      const level = Math.min(6, heading[1].length + 1)
      blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      i++
      continue
    }
    if (RULE.test(line)) { blocks.push('<hr>'); i++; continue }
    if (QUOTE.test(line)) {
      const quoted = []
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(QUOTE.exec(lines[i++])[1])
      blocks.push(`<blockquote>${renderMarkdown(quoted.join('\n'))}</blockquote>`)
      continue
    }
    const list = BULLET.test(line) ? ['ul', BULLET] : NUMBERED.test(line) ? ['ol', NUMBERED] : null
    if (list !== null) {
      const [tag, pattern] = list
      const items = []
      while (i < lines.length && pattern.test(lines[i])) items.push(`<li>${inline(pattern.exec(lines[i++])[1])}</li>`)
      blocks.push(`<${tag}>${items.join('')}</${tag}>`)
      continue
    }
    const paragraph = []
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i])) paragraph.push(lines[i++].trim())
    blocks.push(`<p>${paragraph.map(inline).join('<br>')}</p>`)
  }
  return blocks.join('\n')
}

function startsBlock (line) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || BULLET.test(line) || NUMBERED.test(line)
}

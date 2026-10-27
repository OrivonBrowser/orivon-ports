// The name a website gives itself: the <title> of its index.html. Read as text and shown as text, never as markup.

const READ_BYTES = 32768
export const SITE_TITLE_MAX = 80
const NAMED = /** @type {Record<string, string>} */ ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' })

/** @param {string} entity the part between & and ; */
function decode (entity) {
  if (entity.startsWith('#')) {
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
    return Number.isInteger(code) && code > 31 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' '
  }
  return NAMED[entity.toLowerCase()] ?? `&${entity};`
}

/** The text of the first <title> in an HTML page, tidied, or '' when there is none. @param {string} html */
export function titleOfHtml (html) {
  const match = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i.exec(html.slice(0, READ_BYTES))
  if (match === null) return ''
  return (match[1] ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_all, entity) => decode(entity)).replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, SITE_TITLE_MAX)
}

/** @param {Blob} file the website's index.html */
export async function siteTitleOf (file) {
  try {
    return titleOfHtml(await file.slice(0, READ_BYTES).text())
  } catch {
    return ''
  }
}

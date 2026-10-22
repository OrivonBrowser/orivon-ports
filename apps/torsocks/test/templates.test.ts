import { describe, expect, it } from 'vitest'
import { articlePage, escapeHtml, filesPage, picturePage } from '../page/src/ui/templates.js'

const EVIL = `<script>alert("x")</script> & 'q' "q"`
const ESCAPED = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39; &quot;q&quot;'
const CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; base-uri 'none'; form-action 'none'`

function expectShell (html: string) {
  expect(html.startsWith('<!doctype html>')).toBe(true)
  expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`)
  expect(html).toContain('<meta name="referrer" content="no-referrer">')
  expect(html).toContain('name="viewport"')
  expect(html).toContain('Published over Tor with TorSocks')
  expect(html).not.toContain('<script')
  expect(html).not.toMatch(/https?:\/\//)
  expect(html).not.toMatch(/<link\b/)
  expect(html).not.toMatch(/\son[a-z]+=/i)
}

describe('escapeHtml', () => {
  it('escapes the five characters that matter', () => {
    expect(escapeHtml(EVIL)).toBe(ESCAPED)
  })

  it('turns null and numbers into text', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
    expect(escapeHtml(42)).toBe('42')
  })
})

describe('articlePage', () => {
  const page = articlePage({
    title: EVIL,
    byline: EVIL,
    date: '2026-10-22T23:30:00-05:00',
    bodyHtml: '<p>Hello <strong>world</strong></p>'
  })

  it('escapes the title and byline everywhere they appear', () => {
    expectShell(page)
    expect(page).toContain(`<title>${ESCAPED}</title>`)
    expect(page).toContain(`<h1>${ESCAPED}</h1>`)
    expect(page).toContain(ESCAPED + ' &middot;')
    expect(page).not.toContain('<script>alert')
  })

  it('shows the date as YYYY-MM-DD in UTC', () => {
    expect(page).toContain('>2026-10-23</time>')
  })

  it('inserts the rendered body as it is', () => {
    expect(page).toContain('<p>Hello <strong>world</strong></p>')
  })

  it('leaves out the byline and a date that does not parse', () => {
    const bare = articlePage({ title: 'Plain', byline: '  ', date: 'nope', bodyHtml: '<p>x</p>' })
    expect(bare).not.toContain('class="meta"')
    expect(bare).not.toContain('<time')
    const dated = articlePage({ title: 'Plain', byline: '', date: '2026-01-02T00:00:00Z', bodyHtml: '' })
    expect(dated).toContain('<p class="meta"><time datetime="2026-01-02">2026-01-02</time></p>')
    expect(dated).not.toContain('&middot;')
  })

  it('has a name for an untitled article', () => {
    expect(articlePage({ title: ' ', byline: '', date: '', bodyHtml: '' })).toContain('<h1>Untitled</h1>')
  })
})

describe('picturePage', () => {
  const page = picturePage({ title: EVIL, note: EVIL, image: 'picture.jpg', alt: EVIL })

  it('escapes the title, caption and alt text', () => {
    expectShell(page)
    expect(page).toContain(`<h1>${ESCAPED}</h1>`)
    expect(page).toContain(`<figcaption>${ESCAPED}</figcaption>`)
    expect(page).toContain(`alt="${ESCAPED}"`)
  })

  it('shows the image large and offers the original', () => {
    expect(page).toContain('<img src="picture.jpg"')
    expect(page).toContain('href="picture.jpg" download>Download original</a>')
  })

  it('cannot be broken out of through the file name', () => {
    const odd = picturePage({ title: 't', note: '', image: '"><img src=x onerror=alert(1)>.jpg', alt: '' })
    expect(odd).not.toContain('<img src=x')
    expect(odd).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;.jpg')
    expect(odd).not.toContain('<figcaption>')
  })

  it('keeps a link that looks like a scheme relative', () => {
    expect(picturePage({ title: 't', note: '', image: 'javascript:alert(1)', alt: '' })).toContain('src="./javascript:alert(1)"')
    expect(picturePage({ title: 't', note: '', image: '//evil.example/a.jpg', alt: '' })).toContain('src="./evil.example/a.jpg"')
  })

  it('falls back to the title for alt text', () => {
    expect(picturePage({ title: 'Harbour', note: '', image: 'p.jpg', alt: '' })).toContain('alt="Harbour"')
  })
})

describe('filesPage', () => {
  const files = [
    { name: `${EVIL}.txt`, href: 'a%20b.txt', size: 1536 },
    { name: 'report & data.pdf', href: 'report%20%26%20data.pdf', size: 2 * 1024 * 1024 }
  ]
  const page = filesPage({ title: EVIL, note: EVIL, files })

  it('escapes the title, note and file names', () => {
    expectShell(page)
    expect(page).toContain(`<h1>${ESCAPED}</h1>`)
    expect(page).toContain(`<p class="note">${ESCAPED}</p>`)
    expect(page).toContain(`>${ESCAPED}.txt</a>`)
    expect(page).toContain('>report &amp; data.pdf</a>')
  })

  it('lists each file with its link and a human size', () => {
    expect(page).toContain('href="a%20b.txt"')
    expect(page).toContain('href="report%20%26%20data.pdf"')
    expect(page).toContain('<span class="size">1.5 KB</span>')
    expect(page).toContain('<span class="size">2.0 MB</span>')
    expect(page).toContain('2 files, 2.0 MB')
  })

  it('escapes a link that contains a quote', () => {
    const odd = filesPage({ title: 't', note: '', files: [{ name: 'x', href: 'a"b.txt', size: 1 }] })
    expect(odd).toContain('href="a&quot;b.txt"')
  })

  it('says so when there are no files', () => {
    const none = filesPage({ title: 't', note: '', files: [] })
    expect(none).toContain('There are no files here.')
    expect(none).toContain('0 files, 0 B')
    expect(none).not.toContain('class="files"')
  })
})

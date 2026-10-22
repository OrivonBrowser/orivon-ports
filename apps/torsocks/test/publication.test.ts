import { describe, expect, it } from 'vitest'
import { LIMITS } from '../page/src/model.js'
import {
  extensionOf, folderEntries, newId, planArticle, planFiles, planFolder, planFor, planPicture, planWebsite, safeSegments, uniqueName
} from '../page/src/core/publication.js'

/** A File as the page receives it, with the folder path a folder pick gives it. */
function file (name: string, size = 3, relativePath = '', type = ''): File {
  const made = new File([new Uint8Array(size)], name, { type })
  if (relativePath !== '') Object.defineProperty(made, 'webkitRelativePath', { value: relativePath })
  return made
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe('newId', () => {
  it('is a service id the daemon accepts: 12 of a-z and 2-7', () => {
    for (let i = 0; i < 50; i++) expect(newId()).toMatch(/^[a-z2-7]{12}$/)
    expect(newId((n) => new Uint8Array(n))).toBe('aaaaaaaaaaaa')
  })
})

describe('safeSegments', () => {
  it('refuses any path that could leave the publication', () => {
    expect(safeSegments('a/b.txt')).toEqual(['a', 'b.txt'])
    for (const bad of ['../x', 'a/../b', '/abs', 'a//b', 'a/./b', 'a\\b', 'c:x', 'a\u0000b', 'tab\tname', '']) {
      expect(safeSegments(bad)).toBeNull()
    }
  })
})

describe('planArticle', () => {
  it('writes one page, with the title escaped and the body rendered', () => {
    const plan = planArticle({ title: ' <b>News</b> ', byline: '', body: '# Head\n\nText' }, new Date('2026-05-04T10:00:00Z'))
    expect(plan.kind).toBe('article')
    expect(plan.title).toBe('<b>News</b>')
    expect(plan.entries.map((e: { path: string }) => e.path)).toEqual(['index.html'])
    const html = text(plan.entries[0].source as Uint8Array)
    expect(html).toContain('&lt;b&gt;News&lt;/b&gt;')
    expect(html).toContain('<h2>Head</h2>')
    expect(html).toContain('2026-05-04')
    expect(plan.listing).toBe(false)
    expect(plan.bytes).toBe((plan.entries[0].source as Uint8Array).length)
  })

  it('refuses an empty title or body, and one past the limits', () => {
    expect(() => planArticle({ title: ' ', byline: '', body: 'x' })).toThrow(/title/)
    expect(() => planArticle({ title: 't', byline: '', body: '  ' })).toThrow(/Write/)
    expect(() => planArticle({ title: 'x'.repeat(LIMITS.titleLength + 1), byline: '', body: 'x' })).toThrow(/title/)
    expect(() => planArticle({ title: 't', byline: '', body: 'x'.repeat(LIMITS.articleLength + 1) })).toThrow(/longer/)
  })
})

describe('planPicture', () => {
  it('serves the picture under a fixed name beside its page', () => {
    const plan = planPicture({ title: 'Cat', note: 'n', files: [file('IMG 1.JPG', 10, '', 'image/jpeg')] })
    expect(plan.entries.map((e: { path: string }) => e.path)).toEqual(['index.html', 'picture.jpg'])
    expect(text(plan.entries[0].source as Uint8Array)).toContain('picture.jpg')
  })

  it('takes exactly one image', () => {
    expect(() => planPicture({ title: 'x', note: '', files: [] })).toThrow(/one picture/)
    expect(() => planPicture({ title: 'x', note: '', files: [file('a.txt', 1, '', 'text/plain')] })).toThrow(/not a picture/)
    expect(extensionOf('noext')).toBe('')
    expect(extensionOf('a.tar.GZ')).toBe('gz')
  })
})

describe('planFiles', () => {
  it('lists every file, under unique names, with encoded links', () => {
    const plan = planFiles({ title: 'Docs', note: '', files: [file('a b.txt'), file('a b.txt'), file('x/y.txt')] })
    expect(plan.entries.map((e: { path: string }) => e.path)).toEqual(['index.html', 'files/a b.txt', 'files/a b (2).txt', 'files/x_y.txt'])
    const html = text(plan.entries[0].source as Uint8Array)
    expect(html).toContain('files/a%20b%20(2).txt')
    expect(plan.files).toBe(4)
  })

  it('makes names unique without regard to case', () => {
    const taken = new Set(['readme', 'readme (2)'])
    expect(uniqueName('README', taken)).toBe('README (3)')
    expect(uniqueName('fresh', taken)).toBe('fresh')
  })
})

describe('folders and websites', () => {
  const site = [file('index.html', 5, 'mysite/index.html'), file('a.css', 5, 'mysite/css/a.css')]

  it('drops the picked folder\'s own name', () => {
    expect(folderEntries(site).map((e: { path: string }) => e.path)).toEqual(['index.html', 'css/a.css'])
  })

  it('lists a folder, and serves a website as it is', () => {
    expect(planFolder({ title: 'F', files: site }).listing).toBe(true)
    expect(planWebsite({ title: 'W', files: site }).listing).toBe(false)
  })

  it('wants index.html at the top of a website', () => {
    expect(() => planWebsite({ title: 'W', files: [file('index.html', 1, 'top/docs/index.html')] })).toThrow(/index\.html/)
  })

  it('refuses a path that could leave the folder, and two files at one path', () => {
    expect(() => planFolder({ title: 'F', files: [file('x', 1, 'top/../x')] })).toThrow(/not a name/)
    expect(() => planFolder({ title: 'F', files: [file('A', 1, 'top/A'), file('a', 1, 'top/a')] })).toThrow(/Two files/)
  })

  it('refuses a publication past the limits', () => {
    const many = Array.from({ length: LIMITS.maxFiles + 1 }, (_, i) => file(`f${String(i)}`, 1, `top/f${String(i)}`))
    expect(() => planFolder({ title: 'F', files: many })).toThrow(/at most/)
    const huge = { name: 'big', size: LIMITS.maxBytes + 1, webkitRelativePath: 'top/big' } as unknown as File
    expect(() => planFolder({ title: 'F', files: [huge] })).toThrow(/more than/)
  })

  it('picks the plan by kind', () => {
    expect(planFor({ kind: 'folder', title: 'F', files: site }).kind).toBe('folder')
    expect(() => planFor({ kind: 'article', title: 'x', files: [] })).toThrow(/Nothing publishes/)
  })
})

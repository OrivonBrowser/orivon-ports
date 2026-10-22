import { describe, expect, it } from 'vitest'
import { ImportError, LINEAGE, compareTiddlers, isDropped, normaliseFields, parseJson, prepareImport, tiddlersFromHtml } from '../page/src/import.js'
import { checkHandoff } from '../page/src/receive.js'
import { parseIpfsAddress } from '../page/src/ui/import-dialog.js'

/** A TiddlyWiki 5.2+ page: one JSON store, `<` escaped as TiddlyWiki writes it. */
function page (tiddlers: Record<string, string>[]): string {
  const store = JSON.stringify(tiddlers).replace(/</g, '\\u003c')
  return `<!doctype html><html><head></head><body><div id="styleArea"></div><script class="tiddlywiki-tiddler-store" type="application/json">${store}</script><script src="tiddlywikicore-5.4.1.js"></script></body></html>`
}

describe('tiddlersFromHtml', () => {
  it('reads every JSON store of a page, markup in a tiddler included', () => {
    const html = page([{ title: 'A', text: '<b>bold</b> and </script> inside' }, { title: 'B', text: 'b' }])
      .replace('</body>', '<script class="tiddlywiki-tiddler-store" type="application/json">[{"title":"C","text":"c"}]</script></body>')
    expect(tiddlersFromHtml(html).map((t) => t.title)).toEqual(['A', 'B', 'C'])
    expect(tiddlersFromHtml(html)[0]?.text).toBe('<b>bold</b> and </script> inside')
  })

  it('refuses an encrypted wiki and a page that is not a wiki, by kind', () => {
    expect(() => tiddlersFromHtml('<pre id="encryptedStoreArea">x</pre>')).toThrowError(expect.objectContaining({ name: 'ImportError', kind: 'encrypted' }))
    expect(() => tiddlersFromHtml('<html><body>hello</body></html>', { DOMParserImpl: undefined as never })).toThrowError(expect.objectContaining({ kind: 'not-a-wiki' }))
  })

  it('reports a damaged store rather than importing half of it', () => {
    expect(() => tiddlersFromHtml('<script class="tiddlywiki-tiddler-store" type="application/json">[{"title":</script>')).toThrowError(expect.objectContaining({ kind: 'unreadable' }))
  })
})

describe('parseJson', () => {
  it('takes TiddlyWiki\'s own export, a pen hand-over and a backup', () => {
    expect(parseJson('[{"title":"A","text":"a"}]')).toEqual({ kind: 'tiddlers', tiddlers: [{ title: 'A', text: 'a' }] })
    expect(parseJson(JSON.stringify({ format: 'decentrawiki-handoff', version: 1, tiddlers: [{ title: 'X' }] }))).toEqual({ kind: 'tiddlers', tiddlers: [{ title: 'X' }] })
    expect(parseJson(JSON.stringify({ format: 'decentrawiki-backup', version: 1, wikis: [] }))).toEqual({ kind: 'backup', wikis: [] })
  })

  it('refuses JSON that holds no tiddlers', () => {
    expect(() => parseJson('{"a":1}')).toThrow(ImportError)
    expect(() => parseJson('not json')).toThrowError(expect.objectContaining({ kind: 'unreadable' }))
  })
})

describe('normaliseFields', () => {
  it('makes every field a string, and lists in TiddlyWiki\'s own syntax', () => {
    expect(normaliseFields({ title: 'T', tags: ['one', 'two words'], revision: 3, empty: null })).toEqual({ title: 'T', tags: 'one [[two words]]', revision: '3' })
  })

  it('drops what has no title', () => {
    expect(normaliseFields({ text: 'x' })).toBeNull()
    expect(normaliseFields('x')).toBeNull()
    expect(normaliseFields([{ title: 'x' }])).toBeNull()
  })
})

describe('prepareImport', () => {
  const published = [
    { title: '$:/core', text: '{}', 'plugin-type': 'plugin' },
    { title: '$:/plugins/orivon/decentrawiki', text: '{}', 'plugin-type': 'plugin' },
    { title: '$:/plugins/orivon/decentrawiki-frame', text: '{}' },
    { title: '$:/config/DecentraWiki/EditorURL', text: 'https://evil.example/' },
    { title: '$:/themes/tiddlywiki/vanilla', text: '{}', 'plugin-type': 'theme' },
    { title: '$:/plugins/someone/useful', text: '{}', 'plugin-type': 'plugin' },
    { title: '$:/StoryList', list: 'A' },
    { title: '$:/state/popup/x', text: 'y' },
    { title: LINEAGE, type: 'application/json', text: '{"id":"decentrawiki-guide","previous":"ipfs://bafyold"}' },
    { title: '$:/SiteTitle', text: 'Bisq [[Wiki|x]]' },
    { title: '$:/SiteSubtitle', text: 'Docs' },
    { title: 'A', text: 'first' },
    { title: 'A', text: 'second' }
  ]

  it('keeps the wiki and its own plugins, and drops what the editor supplies or a page left behind', () => {
    const prepared = prepareImport(published)
    expect(prepared.tiddlers.map((t) => t.title).sort()).toEqual(['$:/SiteSubtitle', '$:/SiteTitle', '$:/plugins/someone/useful', 'A'])
    expect(prepared.dropped).toBe(8)
    expect(prepared.count).toBe(1)
  })

  it('lets the last of two tiddlers with one title win, as TiddlyWiki does', () => {
    expect(prepareImport(published).tiddlers.find((t) => t.title === 'A')?.text).toBe('second')
  })

  it('reads the lineage and the title as plain text', () => {
    const prepared = prepareImport(published)
    expect(prepared.lineage).toEqual({ id: 'decentrawiki-guide', previous: 'ipfs://bafyold' })
    expect(prepared.title).toBe('Bisq Wiki')
    expect(prepared.subtitle).toBe('Docs')
  })

  it('ignores a lineage it cannot trust the shape of', () => {
    expect(prepareImport([{ title: LINEAGE, text: '{"id":"<script>"}' }, { title: 'A' }]).lineage).toBeNull()
    expect(prepareImport([{ title: LINEAGE, text: 'nope' }, { title: 'A' }]).lineage).toBeNull()
  })

  it('refuses a wiki with nothing of its own', () => {
    expect(() => prepareImport([{ title: '$:/core' }])).toThrowError(expect.objectContaining({ kind: 'empty' }))
  })

  it('never keeps a title the editor reserves, whatever its spelling of the prefix', () => {
    for (const title of ['$:/plugins/orivon/decentrawiki', '$:/plugins/orivon/decentrawiki/handoff.js', '$:/config/DecentraWiki/Mode', '$:/DecentraWiki/Lineage', '$:/boot/boot.js', '$:/library/sjcl.js']) {
      expect(isDropped(title), title).toBe(true)
    }
    for (const title of ['$:/plugins/orivon/decentrawikiX', '$:/config/Other', 'DecentraWiki', '$:/DecentraWiki/Guide/Styles']) {
      expect(isDropped(title), title).toBe(false)
    }
  })
})

describe('what a page reports about the browser it ran in', () => {
  it('is never taken in, so a published wiki never carries an editor\'s screen, language or address', () => {
    for (const title of ['$:/info/url/full', '$:/info/browser/screen/width', '$:/info/browser/language', '$:/info/darkmode', '$:/config/SaveWikiButton/Template']) {
      expect(isDropped(title), title).toBe(true)
    }
  })
})

describe('compareTiddlers', () => {
  it('counts what a person reads apart from the settings and plugins', () => {
    const local = [{ title: 'A', text: 'a' }, { title: 'B', text: 'b' }, { title: '$:/S', text: '1' }]
    const incoming = [{ title: 'A', text: 'a2' }, { title: 'C', text: 'c' }, { title: '$:/S', text: '2' }]
    expect(compareTiddlers(local, incoming)).toEqual({ added: ['C'], changed: ['A'], removed: ['B'], system: 1 })
  })

  it('finds no difference when only the order of fields differs', () => {
    expect(compareTiddlers([{ title: 'A', text: 'a', tags: 't' }], [{ tags: 't', text: 'a', title: 'A' }])).toEqual({ added: [], changed: [], removed: [], system: 0 })
  })
})

describe('checkHandoff', () => {
  const good = { format: 'decentrawiki-handoff', version: 1, source: { url: 'https://bisq-wiki.eth/', origin: 'https://bisq-wiki.eth', title: 'Bisq' }, focus: { title: 'Install', edit: true }, tiddlers: [{ title: 'A' }] }

  it('takes a hand-over of the current version', () => {
    expect(checkHandoff(good)).toEqual(good)
  })

  it('refuses anything else, by kind', () => {
    for (const bad of [null, 'x', { ...good, format: 'other' }, { ...good, version: 2 }, { ...good, tiddlers: 'x' }]) {
      expect(() => checkHandoff(bad)).toThrowError(expect.objectContaining({ kind: 'unreadable' }))
    }
  })

  it('reads a focus only when it names a title, and strings only', () => {
    expect(checkHandoff({ ...good, focus: { title: 7 } }).focus).toBeNull()
    expect(checkHandoff({ ...good, focus: { title: 'X', edit: 'yes' } }).focus).toEqual({ title: 'X', edit: false })
    expect(checkHandoff({ ...good, source: { url: { toString: () => 'u' } } }).source).toEqual({ url: 'u', origin: '', title: '' })
  })
})

describe('parseIpfsAddress', () => {
  const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

  it('reads every spelling of an IPFS address, defaulting to the index page', () => {
    expect(parseIpfsAddress(`ipfs://${cid}`)).toEqual({ cid, path: 'index.html' })
    expect(parseIpfsAddress(`ipfs://${cid}/docs/`)).toEqual({ cid, path: 'docs/index.html' })
    expect(parseIpfsAddress(`/ipfs/${cid}/a.html`)).toEqual({ cid, path: 'a.html' })
    expect(parseIpfsAddress(` ${cid} `)).toEqual({ cid, path: 'index.html' })
    expect(parseIpfsAddress(`https://${cid}.ipfs.dweb.link/x%20y.html?q=1`)).toEqual({ cid, path: 'x y.html' })
    expect(parseIpfsAddress(`https://ipfs.io/ipfs/${cid}/`)).toEqual({ cid, path: 'index.html' })
    expect(parseIpfsAddress(`https://${cid}.ipfs.orivon/`)).toEqual({ cid, path: 'index.html' })
  })

  it('answers null for what is no IPFS address', () => {
    expect(parseIpfsAddress('https://example.org/')).toBeNull()
    expect(parseIpfsAddress('ipfs://not-a-cid')).toBeNull()
    expect(parseIpfsAddress('')).toBeNull()
  })
})

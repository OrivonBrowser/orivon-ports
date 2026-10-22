import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { checkPublishedPage, storeOf } from '../page/src/publish/publish.js'

const PLUGINS = join(import.meta.dirname, '..', 'wiki', 'plugins', 'orivon')

/** Loads a TiddlyWiki module the way TiddlyWiki does: as a function body with its own `exports`. */
function load (file: string, globals: Record<string, unknown> = {}): Record<string, any> {
  const exports: Record<string, any> = {}
  runInNewContext(readFileSync(join(PLUGINS, file), 'utf8'), { exports, require: () => ({}), ...globals })
  return exports
}

const wikiWith = (texts: Record<string, string>) => ({ getTiddlerText: (title: string, fallback: string) => texts[title] ?? fallback })

describe('the pen finds the editor', () => {
  const { editorAddress } = load('decentrawiki/handoff.js')
  const at = (hostname: string, protocol = 'https:') => ({ hostname, protocol })

  it('at its own name inside Orivon, for a name and for an ipfs:// address', () => {
    expect(editorAddress(wikiWith({}), at('bisq-wiki.eth'))).toBe('https://editor.decentrawiki.eth/')
    expect(editorAddress(wikiWith({}), at('bafybeiabc.ipfs.orivon'))).toBe('https://editor.decentrawiki.eth/')
  })

  it('over plain http when the wiki itself came over it, as a developer name does', () => {
    expect(editorAddress(wikiWith({}), at('decentrawiki.eth', 'http:'))).toBe('http://editor.decentrawiki.eth/')
  })

  it('through the same gateway family the wiki was reached through', () => {
    expect(editorAddress(wikiWith({}), at('bisq-wiki.eth.limo'))).toBe('https://editor.decentrawiki.eth.limo/')
    expect(editorAddress(wikiWith({}), at('bisq-wiki.eth.link'))).toBe('https://editor.decentrawiki.eth.link/')
    expect(editorAddress(wikiWith({}), at('ipfs.io'))).toBe('https://editor.decentrawiki.eth.limo/')
  })

  it('at the address a wiki configures, before any guess', () => {
    expect(editorAddress(wikiWith({ '$:/config/DecentraWiki/EditorURL': ' http://127.0.0.1:8895/ ' }), at('bisq-wiki.eth'))).toBe('http://127.0.0.1:8895/')
  })
})

describe('the pen hands over the wiki as it was published', () => {
  const { publishedTiddlers } = load('decentrawiki/handoff.js')

  it('reads every store area, never the live wiki', () => {
    const doc = {
      querySelectorAll: () => [
        { textContent: '[{"title":"A","text":"a"},{"text":"no title"}]' },
        { textContent: '[{"title":"B"}]' }
      ]
    }
    expect(publishedTiddlers(doc).map((t: { title: string }) => t.title)).toEqual(['A', 'B'])
  })
})

describe('what the editing frame keeps', () => {
  const { kept } = load('decentrawiki-frame/frame-sync.js')

  it('keeps what a person made, drafts included', () => {
    for (const title of ['Welcome', "Draft of 'Welcome'", '$:/SiteTitle', '$:/plugins/someone/useful', '$:/palette', '$:/DecentraWiki/Guide/Styles']) expect(kept(title), title).toBe(true)
  })

  it('never keeps passing state or the editor\'s own tiddlers', () => {
    for (const title of ['$:/StoryList', '$:/HistoryList', '$:/Import', '$:/state/popup/x', '$:/temp/x', '$:/status/UserName',
      '$:/plugins/orivon/decentrawiki-frame', '$:/plugins/orivon/decentrawiki-frame/frame-sync.js', '$:/config/DecentraWiki/Mode', '$:/DecentraWiki/Lineage',
      '$:/info/url/full', '$:/info/browser/screen/width', '$:/config/SaveWikiButton/Template']) {
      expect(kept(title), title).toBe(false)
    }
  })
})

describe('a page the editor publishes', () => {
  const viewer = '{"tiddlers":{"$:/plugins/orivon/decentrawiki/viewer.js":{"text":"..."}}}'
  const own = { core: 'tiddlywikicore-5.4.1.js', viewer }
  const page = (tiddlers: Record<string, string>[], core = own.core) =>
    `<html><body><script class="tiddlywiki-tiddler-store" type="application/json">${JSON.stringify(tiddlers)}</script><script src="${core}" onerror="x"></script></body></html>`
  const good = [{ title: '$:/plugins/orivon/decentrawiki', text: viewer }, { title: 'A', text: 'a' }]

  it('passes when it loads the shared core and carries the pen as shipped', () => {
    expect([...checkPublishedPage(page(good), own).keys()]).toEqual(['$:/plugins/orivon/decentrawiki', 'A'])
  })

  it('is refused when a plugin of the wiki replaced the pen', () => {
    expect(() => checkPublishedPage(page([{ title: '$:/plugins/orivon/decentrawiki', text: '{"evil":true}' }]), own)).toThrow(/changed the DecentraWiki pen/)
    expect(() => checkPublishedPage(page([{ title: 'A' }]), own)).toThrow(/changed the DecentraWiki pen/)
  })

  it('is refused when it loads another core, or carries the frame\'s own tiddlers', () => {
    expect(() => checkPublishedPage(page(good, 'tiddlywikicore-5.3.0.js'), own)).toThrow(/core/)
    expect(() => checkPublishedPage(page([...good, { title: '$:/config/DecentraWiki/Mode', text: 'edit' }]), own)).toThrow(/own settings/)
  })

  it('reads several stores, later titles replacing earlier ones', () => {
    const html = page([{ title: 'A', text: '1' }]) + '<script class="tiddlywiki-tiddler-store" type="application/json">[{"title":"A","text":"2"}]</script>'
    expect(storeOf(html).get('A')?.text).toBe('2')
  })
})

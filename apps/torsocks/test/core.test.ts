import { describe, expect, it } from 'vitest'
import { inline, renderMarkdown, safeHref } from '../page/src/core/markdown.js'
import { applyEvent, emptyRuntime, fatalText } from '../page/src/core/events.js'
import { lineSplitter } from '../page/src/core/daemon.js'
import { mergeService } from '../page/src/core/store.js'
import { initialState } from '../page/src/model.js'

describe('renderMarkdown', () => {
  it('escapes every character of the text before any markup', () => {
    const html = renderMarkdown('<script>alert(1)</script> & "quotes" <img src=x onerror=y>')
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot; &lt;img src=x onerror=y&gt;</p>')
  })

  it('makes the blocks an article uses', () => {
    const html = renderMarkdown('# Title\n\nA *b* **c** `d`\nline two\n\n> quoted\n\n- one\n- two\n\n1. first\n\n---\n\n```\n<code>\n```')
    expect(html).toContain('<h2>Title</h2>')
    expect(html).toContain('<p>A <em>b</em> <strong>c</strong> <code>d</code><br>line two</p>')
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>')
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>')
    expect(html).toContain('<ol><li>first</li></ol>')
    expect(html).toContain('<hr>')
    expect(html).toContain('<pre><code>&lt;code&gt;</code></pre>')
  })

  it('links only to the web, mail and the site itself', () => {
    expect(inline('[a](https://x.example/?q=1&r=2)')).toBe('<a href="https://x.example/?q=1&amp;r=2" rel="noreferrer">a</a>')
    expect(inline('[a](page.html)')).toBe('<a href="page.html" rel="noreferrer">a</a>')
    expect(inline('[a](javascript:alert(1))')).not.toContain('<a')
    expect(inline('[a](data:text/html,x)')).not.toContain('<a')
    expect(inline('[a](//evil.example)')).not.toContain('<a')
    expect(safeHref(' mailto:x@y.example ')).toBe('mailto:x@y.example')
  })

  it('keeps an attribute closed whatever the link text holds', () => {
    expect(inline('[x" onmouseover="y](https://a.example/"b)')).toBe('<a href="https://a.example/&quot;b" rel="noreferrer">x&quot; onmouseover=&quot;y</a>')
  })

  it('cannot be confused by the placeholder character', () => {
    expect(inline('\u00000\u0000 `c`')).toBe('0 <code>c</code>')
  })
})

describe('applyEvent', () => {
  const start = () => ({ state: initialState(), runtime: emptyRuntime() })

  it('follows bootstrap, the proxy and its traffic', () => {
    let s = applyEvent(start(), { t: 'bootstrap', frac: 0.5, ready: false, msg: '50%', blocked: null })
    s = applyEvent(s, { t: 'socks', state: 'listening', host: '127.0.0.1', port: 9150 })
    s = applyEvent(s, { t: 'traffic', open: 2, total: 9 })
    expect(s.state.bootstrap).toEqual({ frac: 0.5, ready: false, msg: '50%', blocked: null })
    expect(s.state.socks).toEqual({ state: 'listening', host: '127.0.0.1', port: 9150, msg: '' })
    expect(s.state.traffic).toEqual({ open: 2, total: 9 })
    s = applyEvent(s, { t: 'socks', state: 'failed', msg: 'in use' })
    expect(s.state.socks.state).toBe('failed')
    expect(s.state.socks.msg).toBe('in use')
  })

  it('keeps what the daemon says per service, and forgets it on request', () => {
    let s = applyEvent(start(), { t: 'service', id: 'a', state: 'running', onion: 'x.onion', problem: null }, 500)
    s = applyEvent(s, { t: 'hits', id: 'a', count: 3 }, 600)
    s = applyEvent(s, { t: 'check', id: 'a', ok: true, status: 'HTTP/1.1 200 OK', ms: 812 }, 1000)
    expect(s.runtime.services.a).toEqual({
      state: 'running',
      onion: 'x.onion',
      problem: null,
      waitingSince: null,
      hits: 3,
      check: { pending: false, ok: true, text: 'Reached through Tor: HTTP/1.1 200 OK', ms: 812, at: 1000, auto: false },
      passedAt: 1000
    })
    s = applyEvent(s, { t: 'service', id: 'a', state: 'nonsense' })
    expect(s.runtime.services.a?.state).toBe('broken')
    s = applyEvent(s, { t: 'forgotten', id: 'a' })
    expect(s.runtime.services.a).toBeUndefined()
  })

  it('keeps at most 400 log lines, oldest dropped', () => {
    let s = start()
    for (let i = 0; i < 405; i++) s = applyEvent(s, { t: 'log', level: 'INFO', target: 't', msg: String(i) }, 1)
    expect(s.state.logs).toHaveLength(400)
    expect(s.state.logs[0]?.msg).toBe('5')
  })

  it('turns a fatal start into words', () => {
    const s = applyEvent(start(), { t: 'fatal', code: 'control-port-busy', msg: 'port 9159: in use' })
    expect(s.state.phase).toBe('failed')
    expect(s.state.error).toMatch(/127\.0\.0\.1:9159/)
    expect(s.state.error, 'it says what to do').toMatch(/close its other tab/)
    expect(fatalText({ code: 'other', msg: 'boom' })).toBe('boom')
  })

  it('returns a new state and leaves the old one as it was', () => {
    const before = start()
    const after = applyEvent(before, { t: 'traffic', open: 1, total: 1 })
    expect(after.state).not.toBe(before.state)
    expect(before.state.traffic).toEqual({ open: 0, total: 0 })
  })
})

describe('applyEvent and the tests the page runs itself', () => {
  const start = () => ({ state: initialState(), runtime: emptyRuntime() })
  const at = (s: ReturnType<typeof start>, event: object, now: number) => applyEvent(s, event, now)
  const pending = (s: ReturnType<typeof start>, auto: boolean, now: number) => ({
    ...s,
    runtime: { services: { ...s.runtime.services, a: { ...s.runtime.services['a'], check: { pending: true, ok: false, text: '', ms: 0, at: now, auto } } } }
  })

  it('starts waiting when a service has an address and Arti has not settled', () => {
    let s = at(start(), { t: 'service', id: 'a', state: 'starting', onion: null }, 100)
    expect(s.runtime.services['a']?.waitingSince, 'no address yet').toBeNull()
    s = at(s, { t: 'service', id: 'a', state: 'starting', onion: 'x.onion' }, 200)
    expect(s.runtime.services['a']?.waitingSince).toBe(200)
    s = at(s, { t: 'service', id: 'a', state: 'publishing', onion: 'x.onion' }, 300)
    expect(s.runtime.services['a']?.waitingSince, 'a later state of the same wait does not restart it').toBe(200)
  })

  it('ends the wait when Arti settles and starts another when it moves away again', () => {
    let s = at(start(), { t: 'service', id: 'a', state: 'publishing', onion: 'x.onion' }, 100)
    s = at(s, { t: 'service', id: 'a', state: 'running', onion: 'x.onion' }, 200)
    expect(s.runtime.services['a']?.waitingSince).toBeNull()
    s = at(s, { t: 'service', id: 'a', state: 'publishing', onion: 'x.onion' }, 900)
    expect(s.runtime.services['a']?.waitingSince).toBe(900)
  })

  it('remembers a pass, keeps it across running, and drops it when the service stops or breaks', () => {
    let s = at(start(), { t: 'service', id: 'a', state: 'publishing', onion: 'x.onion' }, 100)
    s = at(pending(s, true, 150), { t: 'check', id: 'a', ok: true, status: 'HTTP/1.1 200 OK', ms: 5 }, 160)
    expect(s.runtime.services['a']).toMatchObject({ passedAt: 160, check: { ok: true, auto: true, at: 160 } })
    s = at(s, { t: 'service', id: 'a', state: 'running', onion: 'x.onion' }, 200)
    expect(s.runtime.services['a']?.passedAt).toBe(160)
    s = at(s, { t: 'service', id: 'a', state: 'stopped', onion: 'x.onion' }, 300)
    expect(s.runtime.services['a']?.passedAt).toBeNull()
    s = at(s, { t: 'service', id: 'a', state: 'publishing', onion: 'x.onion' }, 400)
    s = at(pending(s, true, 410), { t: 'check', id: 'a', ok: true, status: 'HTTP/1.1 200 OK' }, 420)
    s = at(s, { t: 'service', id: 'a', state: 'broken', error: 'boom' }, 500)
    expect(s.runtime.services['a']?.passedAt).toBeNull()
  })

  it('forgets an earlier pass when a later test fails, and counts no pass for a service that is not running', () => {
    let s = at(start(), { t: 'service', id: 'a', state: 'publishing', onion: 'x.onion' }, 100)
    s = at(s, { t: 'check', id: 'a', ok: true, status: 'HTTP/1.1 200 OK' }, 160)
    s = at(s, { t: 'check', id: 'a', ok: false, msg: 'no answer within two minutes' }, 400)
    expect(s.runtime.services['a']?.passedAt).toBeNull()
    s = at(s, { t: 'service', id: 'a', state: 'stopped' }, 500)
    s = at(s, { t: 'check', id: 'a', ok: true, status: 'HTTP/1.1 200 OK' }, 600)
    expect(s.runtime.services['a']?.passedAt, 'a late answer after stop').toBeNull()
    expect(at(start(), { t: 'check', id: 'z', ok: true, status: 'x' }, 1).runtime.services['z']?.passedAt, 'a service the daemon never reported').toBeUndefined()
  })

  it('marks an answer as automatic only when the page asked for it', () => {
    let s = at(start(), { t: 'service', id: 'a', state: 'publishing', onion: 'x.onion' }, 100)
    expect(at(pending(s, true, 150), { t: 'check', id: 'a', ok: false, msg: 'x' }, 160).runtime.services['a']?.check?.auto).toBe(true)
    expect(at(pending(s, false, 150), { t: 'check', id: 'a', ok: false, msg: 'x' }, 160).runtime.services['a']?.check?.auto).toBe(false)
    s = at(s, { t: 'check', id: 'a', ok: false, msg: 'x' }, 160)
    expect(s.runtime.services['a']?.check?.auto, 'a test another tab asked for').toBe(false)
  })
})

describe('mergeService', () => {
  const entry = { id: 'a', kind: 'article', title: 'T', created: '2026-01-01T00:00:00.000Z', enabled: true, onion: 'kept.onion', bytes: 10, files: 1 }

  it('takes the live state over the kept one', () => {
    const runtime = { services: { a: { state: 'running', onion: 'live.onion', hits: 4 } } }
    expect(mergeService(entry, runtime)).toMatchObject({ state: 'running', onion: 'live.onion', hits: 4 })
    expect(mergeService(entry, emptyRuntime())).toMatchObject({ state: 'starting', onion: 'kept.onion', hits: 0 })
  })

  it('says a service is reached only while Arti waits and the pass is recent', () => {
    const live = (change: object) => ({ services: { a: { onion: 'x.onion', state: 'publishing', waitingSince: 1000, passedAt: 5000, ...change } } })
    expect(mergeService(entry, live({}), 6000)).toMatchObject({ reached: true, waitingSince: 1000, passedAt: 5000 })
    expect(mergeService(entry, live({}), 5000 + 600_000).reached, 'ten minutes later').toBe(false)
    expect(mergeService(entry, live({ state: 'running' }), 6000).reached, 'Arti has settled').toBe(false)
    expect(mergeService(entry, live({ passedAt: null }), 6000).reached).toBe(false)
    expect(mergeService({ ...entry, enabled: false }, live({}), 6000).reached, 'switched off').toBe(false)
    expect(mergeService(entry, emptyRuntime(), 6000)).toMatchObject({ reached: false, waitingSince: null, passedAt: null })
  })

  it('shows a service the person switched off as off, whatever the daemon last said', () => {
    const runtime = { services: { a: { state: 'running', problem: 'x' } } }
    expect(mergeService({ ...entry, enabled: false }, runtime)).toMatchObject({ state: 'off', problem: null })
  })
})

describe('lineSplitter', () => {
  it('splits across chunks and keeps a partial line for later', () => {
    const split = lineSplitter()
    const bytes = new TextEncoder().encode('{"a":1}\n{"b"')
    expect(split(bytes)).toEqual(['{"a":1}'])
    expect(split(new TextEncoder().encode(':2}\n\n'))).toEqual(['{"b":2}'])
  })

  it('does not break a character split between chunks', () => {
    const split = lineSplitter()
    const bytes = new TextEncoder().encode('é\n')
    expect(split(bytes.slice(0, 1))).toEqual([])
    expect(split(bytes.slice(1))).toEqual(['é'])
  })
})

// The HTML hook: a base before the head, the backend script inside it, nothing twice.
import { describe, expect, it } from 'vitest'
import { transformHtml } from '../hooks.mjs'

const page = '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <title>Actual</title>\n  </head>\n  <body><div id="root"></div></body>\n</html>'

describe('transformHtml', () => {
  it('puts the base before <head> and the backend script first inside it', () => {
    const out = transformHtml(page) as string
    expect(out.indexOf('<base href="/">')).toBeLessThan(out.indexOf('<head>'))
    expect(out.indexOf('<head>')).toBeLessThan(out.indexOf('<script src="orivon/actual-backend.js"></script>'))
    expect(out.indexOf('<script src="orivon/actual-backend.js"></script>')).toBeLessThan(out.indexOf('<meta charset'))
  })

  it('is idempotent', () => {
    const once = transformHtml(page) as string
    expect(transformHtml(once)).toBe(once)
  })

  it('refuses a page with no head, and a head with attributes the base would drop', () => {
    expect(() => transformHtml('<html><body></body></html>')).toThrow(/no <head>/)
    expect(() => transformHtml('<html><head data-x="1"></head></html>')).toThrow(/carries attributes/)
  })
})

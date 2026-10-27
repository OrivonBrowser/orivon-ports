import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCES = join(import.meta.dirname, '..', 'page')

const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? files(path) : /\.(js|html|css)$/.test(name) ? [path] : []
})

// A share's password is an encryption key, never a login. The browser offers to save anything typed into a
// password field as a login, so the page draws its secret boxes as text boxes (`secretInput`). The one exception is
// a browser that cannot draw a text box as dots, where `setSecretShown` masks with a password box instead.
const FALLBACK = "if (!CAN_DRAW_DOTS) input.type = shown ? 'text' : 'password'"

describe('the page has no password field', () => {
  it('never makes an input of type password, except where the browser cannot draw dots', () => {
    const found = files(SOURCES).flatMap((path) => readFileSync(path, 'utf8').split('\n').flatMap((line, index) =>
      line.trim() !== FALLBACK && /\btype\b\s*[:=][^,;]*['"]password['"]|input\[type=['"]?password/.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : []))
    expect(found).toEqual([])
    expect(readFileSync(join(SOURCES, 'src', 'dom.js'), 'utf8')).toContain(`const CAN_DRAW_DOTS = typeof CSS !== 'undefined' && CSS.supports('-webkit-text-security', 'disc')\n`)
    expect(readFileSync(join(SOURCES, 'src', 'dom.js'), 'utf8')).toContain(FALLBACK)
  })

  it('keeps the secret boxes out of what a browser may save or fill', () => {
    const source = readFileSync(join(SOURCES, 'src', 'dom.js'), 'utf8')
    for (const attribute of ["type: 'text'", "autocomplete: 'off'", "autocapitalize: 'off'", "spellcheck: 'false'", 'secret-masked']) expect(source).toContain(attribute)
    expect(readFileSync(join(SOURCES, 'styles.css'), 'utf8')).toMatch(/\.secret-masked\s*\{[^}]*-webkit-text-security:\s*disc/)
  })
})

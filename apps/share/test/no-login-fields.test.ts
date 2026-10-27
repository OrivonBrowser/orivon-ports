import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCES = join(import.meta.dirname, '..', 'page')

const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? files(path) : /\.(js|html|css)$/.test(name) ? [path] : []
})

// A share's password is an encryption key, never a login. The browser offers to save anything typed into a
// password field as a login, so the page draws its secret boxes as text boxes (`secretInput`).
describe('the page has no password field', () => {
  it('never makes an input of type password', () => {
    const found = files(SOURCES).flatMap((path) => readFileSync(path, 'utf8').split('\n').flatMap((line, index) =>
      /type\s*[:=]\s*['"]password['"]|\.type\s*=\s*['"]password['"]|input\[type=['"]?password/.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : []))
    expect(found).toEqual([])
  })

  it('keeps the secret boxes out of what a browser may save or fill', () => {
    const source = readFileSync(join(SOURCES, 'src', 'dom.js'), 'utf8')
    for (const attribute of ["type: 'text'", "autocomplete: 'off'", "autocapitalize: 'off'", "spellcheck: 'false'", 'secret-masked']) expect(source).toContain(attribute)
    expect(readFileSync(join(SOURCES, 'styles.css'), 'utf8')).toMatch(/\.secret-masked\s*\{[^}]*-webkit-text-security:\s*disc/)
  })
})

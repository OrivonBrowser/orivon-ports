import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import * as connect from '../site/sdk/connect.js'
import { ACTION, ANSWER, ASK, COPY, FAILURE_WORDS, MANIFEST, RELYING_SITE_RULES } from '../site/developers-model.js'

const protocol = await readFile(new URL('../site/PROTOCOL.md', import.meta.url), 'utf8')
const samples = { ASK, ANSWER, ACTION }

describe('the code a relying site copies', () => {
  it('imports only what the SDK exports', () => {
    for (const [name, code] of Object.entries(samples)) {
      const imports = [...code.matchAll(/import \{([^}]+)\} from '\.\/sdk\/connect\.js'/g)]
      expect(imports.length, name).toBeGreaterThan(0)
      for (const found of imports) for (const member of (found[1] ?? '').split(',').map((one) => one.trim())) expect(connect, `${name}: ${member}`).toHaveProperty(member)
    }
  })

  it('gives appKey and verifyAction the page\'s own origin, and every call that names the key does', () => {
    for (const [name, code] of Object.entries(samples)) {
      for (const call of code.matchAll(/appKey\(([^)]*)\)/g)) expect(call[1], `${name}: appKey`).toBe('orivon, { origin: location.origin }')
    }
    expect(ACTION).toMatch(/verifyAction\(\{[^}]*origin: location\.origin/)
    expect(ASK).toContain('appKey(orivon, { origin: location.origin })')
  })

  it('keeps the browser\'s referrer policy, and returns to a page of the site\'s own origin', () => {
    expect(ASK).toMatch(/returnUrl: location\.origin \+ '\/[a-z-]+'/)
    expect(`${ASK}\n${ANSWER}\n${ACTION}\n${COPY}`).not.toMatch(/no-referrer|noreferrer|referrerPolicy|same-origin/)
    expect(ASK).toContain('default referrer policy')
  })

  it('declares the curve the SDK uses', () => {
    expect(MANIFEST).toBe('"capabilities": { "id": { "curves": ["P-256"] } }')
  })
})

describe('what a relying site must do', () => {
  const section = protocol.slice(protocol.indexOf('## 9. What a relying site must do'))
  const bullets = [...section.split('**What stays at risk.**')[0]!.matchAll(/^- \*\*(.+?)\*\*/gms)].map((found) => (found[1] ?? '').replace(/\s+/g, ' '))
  const lead = { redirect: /open redirect/i, referrer: /referrer policy/i, sdk: /Verify with this SDK/i, payload: /payload of each action/i }

  it('has one rule for each requirement of the protocol, in its order, and none more', () => {
    expect(bullets.length).toBeGreaterThan(0)
    expect(RELYING_SITE_RULES.map((rule) => rule.id)).toEqual(Object.keys(lead))
    expect(RELYING_SITE_RULES).toHaveLength(bullets.length)
    RELYING_SITE_RULES.forEach((rule, index) => expect(bullets[index], rule.id).toMatch(lead[rule.id]))
  })

  it('says the three things a person with a key must not break: the redirect, the referrer and the origin', () => {
    const text = RELYING_SITE_RULES.map((rule) => rule.words).join(' ')
    expect(text).toContain('3xx')
    expect(text).toContain('unknownOrigin')
    expect(text).toContain('Give appKey and verifyAction your own origin')
  })
})

describe('the words for every refusal', () => {
  it('has words for each failure the SDK names, and none for a failure it does not', () => {
    expect(Object.keys(FAILURE_WORDS).sort()).toEqual([...connect.FAILURES].sort())
    for (const [name, words] of Object.entries(FAILURE_WORDS)) expect(words.length, name).toBeGreaterThan(20)
  })

  it('names the details a refusal can carry', () => {
    expect(FAILURE_WORDS.badSignature).toContain('highS')
    expect(FAILURE_WORDS.badActionSignature).toContain('highS')
    expect(FAILURE_WORDS.notAttributed).toContain('rolesUnreadable')
    for (const detail of ['notPermissionedResolver', 'textRoleMissing', 'addressRoleMissing', 'unreadable']) expect(FAILURE_WORDS.recordsNotHeld).toContain(detail)
    expect(FAILURE_WORDS.resolverChanged.length).toBeGreaterThan(20)
  })
})

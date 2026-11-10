import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import * as connect from '../site/sdk/connect.js'
import { ACTION, ANSWER, ASK, COPY, FAILURE_WORDS, MANIFEST, RELYING_SITE_RULES, WORKS_IN } from '../site/developers-model.js'

const protocol = await readFile(new URL('../site/PROTOCOL.md', import.meta.url), 'utf8')
const samples = { ASK, ANSWER, ACTION }

describe('the code a relying site copies', () => {
  it('imports only what the SDK exports', () => {
    for (const [name, code] of Object.entries(samples)) {
      const imports = [...code.matchAll(/import \{([^}]+)\} from '\.\/\.well-known\/orivon-id\/connect\.js'/g)]
      expect(imports.length, name).toBeGreaterThan(0)
      for (const found of imports) for (const member of (found[1] ?? '').split(',').map((one) => one.trim())) expect(connect, `${name}: ${member}`).toHaveProperty(member)
    }
  })

  it('gives appKey and verifyAction the page\'s own origin, and every call that names the key does', () => {
    for (const [name, code] of Object.entries(samples)) {
      for (const call of code.matchAll(/appKey\(([^)]*)\)/g)) expect(call[1], `${name}: appKey`).toBe('orivon, { origin: location.origin }')
    }
    expect(ACTION).toMatch(/verifyAction\(\{[^}]*origin: location\.origin/)
  })

  it('asks for the key with a flag and gives Orivon, never a key; and lands on a path of the site\'s own', () => {
    expect(ASK).toMatch(/delegate: true,/)
    expect(ASK).toMatch(/after: '\/[a-z-]+'/)
    expect(ASK).toContain('}, { orivon })')
    expect(ASK).not.toMatch(/delegateKey|returnUrl|publicKey/)
    expect(`${ASK}\n${ANSWER}\n${ACTION}\n${COPY}`).not.toMatch(/\.\/sdk\//)
    expect(COPY).toContain('/.well-known/orivon-id/')
  })

  it('takes the answer once, on the page at after and in the tab that asked', () => {
    expect(ANSWER).toContain('takeAnswer()')
    expect(ANSWER).toContain('onAnswer(finish)')
    expect(ANSWER).not.toMatch(/readResponse|location\.hash/)
  })

  it('declares the curve the SDK uses', () => {
    expect(MANIFEST).toBe('"capabilities": { "id": { "curves": ["P-256"] } }')
  })
})

describe('what a relying site must do', () => {
  const section = protocol.slice(protocol.indexOf('## 9. What a relying site must do'))
  const bullets = [...section.split('**What stays at risk.**')[0]!.matchAll(/^- \*\*(.+?)\*\*/gms)].map((found) => (found[1] ?? '').replace(/\s+/g, ' '))
  const lead = { bridge: /bridge page/i, injection: /script/i, sdk: /Verify with this SDK/i, payload: /payload of each action/i }

  it('has one rule for each requirement of the protocol, in its order, and none more', () => {
    expect(bullets.length).toBeGreaterThan(0)
    expect(RELYING_SITE_RULES.map((rule) => rule.id)).toEqual(Object.keys(lead))
    expect(RELYING_SITE_RULES).toHaveLength(bullets.length)
    RELYING_SITE_RULES.forEach((rule, index) => expect(bullets[index], rule.id).toMatch(lead[rule.id]))
  })

  it('says what breaks the bridge, and that the key is read from Orivon and never from an address', () => {
    const text = RELYING_SITE_RULES.map((rule) => rule.words).join(' ')
    expect(text).toContain('no rewrite, no redirect, no service worker')
    expect(text).toContain('never taken from an address')
    expect(text).toContain('Give appKey and verifyAction your own origin')
  })
})

describe('where sign-in works', () => {
  it('tells a site author to serve the bridge page at its exact path, with no pretty-URL rewrite, and names the hosts that do one', () => {
    const bridge = RELYING_SITE_RULES.find((rule) => rule.id === 'bridge')?.words ?? ''
    for (const word of ['exact path', 'no pretty-URL rewrite', 'Cloudflare Pages', 'Netlify', 'Vercel']) expect(bridge, word).toContain(word)
    expect(protocol.replace(/\s+/g, ' ')).toContain('Serve it at that exact path, with no pretty-URL rewrite: Cloudflare Pages redirects `bridge.html` to `/bridge` by default, and Netlify and Vercel do when pretty URLs are on')
  })

  it('says Orivon and Chromium-based browsers, and that a browser that trims the referrer stops the sign-in safely, in the page and in the protocol', () => {
    expect(WORKS_IN).toContain('Sign-in works in Orivon and in Chromium-based browsers')
    expect(WORKS_IN).toMatch(/trims the address it tells other sites[\s\S]*the sign-in stops here[\s\S]*nothing is signed/)
    expect(protocol).toContain('Sign-in is built for Orivon and for Chromium-based browsers')
    expect(protocol.replace(/\s+/g, ' ')).toContain('trims a cross-site referrer to the origin stops every sign-in at step 5 of section 2, with words, and nothing is signed')
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

// The scenes of the screenshot script for the sign-in screens a Web3site sends a person to: the Continue screen, the consent screen in each
// state of the person's IDs, and every stop. A confirmation scene holds the challenge of its link in the tab, and arrives from the bridge page
// of its audience (the runner of shoot.mjs does both unless the scene says otherwise).

export function connectScenes ({ RICH, KEY, AUDIENCE, LONG_AUDIENCE, CHALLENGE, NONCE, NOT_BEFORE, ENDS_LATER, arrivalHash, connectHash, inView, arrivalInView }) {
  return {
    'connect-key': { scenario: RICH, hash: connectHash(`&state=abc&delegate=${KEY}&ttl=2592000`), waitFor: '.terms', fold: true, run: inView },
    'connect-plain': { scenario: RICH, hash: connectHash(), waitFor: '.terms', fold: true, run: inView },
    'connect-usable': {
      scenario: { names: ['alice', 'bob-1'] }, hash: connectHash(), waitFor: '.terms', fold: true,
      run: async (page, expect, viewport) => {
        await inView(page, expect, viewport)
        expect(await page.locator('.not-offered').count() === 0, 'the screen of an address whose IDs can all sign in lists IDs that cannot')
      }
    },
    'connect-ended': {
      scenario: { names: ['alice', 'bob-1'], texts: { alice: { [NOT_BEFORE]: ENDS_LATER } } }, hash: connectHash(), waitFor: '.not-offered', fold: true,
      run: async (page, expect, viewport) => {
        await inView(page, expect, viewport)
        expect(await page.locator('.not-offered').textContent().then((text) => text.includes('alice.v1.orivonid.eth') && text.includes('was just ended')), 'the ID whose sign-ins were just ended is not listed apart with why')
        expect(await page.locator('.ids-pick input[type=checkbox]').count() === 1, 'an ID whose sign-ins were just ended can be ticked')
      }
    },
    'connect-ended-all': {
      scenario: { names: ['alice'], texts: { alice: { [NOT_BEFORE]: ENDS_LATER } } }, hash: connectHash(), waitFor: '.not-offered', fold: true,
      run: async (page, expect) => {
        expect(await page.locator('.notice.info').textContent().then((text) => text.includes('were just ended')), 'the screen with every ID just ended says so')
        expect(await page.getByRole('button', { name: 'Check again' }).count() === 1, 'no way to check again once the time has passed')
      }
    },
    'connect-noid': { scenario: { dai: 5 }, hash: connectHash(), waitFor: '.notice.info' },
    'connect-nowallet': { noOrivon: true, hash: connectHash(), waitFor: '.notice.warn' },
    'connect-arrival': { scenario: RICH, hash: arrivalHash(AUDIENCE), waitFor: '.connect > .actions button', fold: true, run: arrivalInView },
    'connect-arrival-long': { audience: LONG_AUDIENCE, hash: arrivalHash(LONG_AUDIENCE), waitFor: '.connect > .actions button', fold: true, run: arrivalInView },
    'connect-invalid': { hash: `#/connect?v=2&c=${CHALLENGE}&nonce=x`, waitFor: '.notice.bad' },
    'connect-invalid-audience': { hash: '#/connect?v=2&aud=http%3A%2F%2Fapp.example.org', waitFor: '.notice.bad' },
    'connect-older': { hash: `#/connect?v=1&return=${encodeURIComponent(`${AUDIENCE}/signed-in`)}&nonce=${NONCE}`, waitFor: '.notice.bad' },
    'connect-long': { scenario: RICH, audience: LONG_AUDIENCE, hash: connectHash(`&delegate=${KEY}&ttl=600`), waitFor: '.terms' },
    'connect-framed': { scenario: RICH, hash: connectHash(`&delegate=${KEY}&ttl=2592000`), frame: true, wait: (page) => page.frameLocator('iframe').locator('.notice.bad').waitFor() },
    'connect-wrong-origin': { scenario: RICH, hash: connectHash(`&delegate=${KEY}&ttl=2592000`), referer: 'https://evil.example/win-a-prize', waitFor: '.notice.bad' },
    'connect-no-referrer': { scenario: RICH, hash: connectHash(), referer: '', waitFor: '.notice.bad' },
    'connect-no-challenge': { scenario: RICH, hash: connectHash(), challenge: null, waitFor: '.notice.bad' },
    'connect-challenge-expired': { scenario: RICH, hash: connectHash(), challenge: { age: 200 }, waitFor: '.notice.bad' },
    'connect-challenge-other': { scenario: RICH, hash: connectHash(), challenge: { c: 'Zz9yXx8wVv7uTt6sRr5qPp4oNn3mLl2k' }, waitFor: '.notice.bad' },
    'connect-not-started': { scenario: RICH, hash: `#/connect?v=2&c=${CHALLENGE}&none=1`, waitFor: '.notice.bad' },
    'connect-not-offered': {
      scenario: { names: ['alice'], unsetNames: ['dave'], notHeld: ['carol'] }, hash: connectHash(), waitFor: '.not-offered', fold: true,
      run: async (page, expect, viewport) => {
        await inView(page, expect, viewport)
        expect(await page.locator('.not-offered li').count() === 2, 'the two IDs that cannot sign in are not listed apart')
        expect(await page.locator('.ids-pick input[type=checkbox]').count() === 1, 'an ID that cannot sign in can be ticked')
      }
    }
  }
}

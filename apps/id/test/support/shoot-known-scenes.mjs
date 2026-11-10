// The scenes of the screenshot script for IDs the page may not find by itself: a registry whose history lies beyond what a
// light client gives (`farHead`), IDs remembered on the device, the form that adds one by name, and a node that gives no log.

/** The known list the device keeps for the fake wallet, written to localStorage before the page loads. */
const remembered = (key, ...labels) => ({ [key]: JSON.stringify({ version: 1, labels }) })
const FAR = 20_000

export function knownScenes ({ RICH, connectHash, inView, knownKey, sleep }) {
  const far = { ...RICH, farHead: FAR }
  const listed = (page) => page.locator('article.id-card').count()
  const addByName = async (page, typed) => {
    await page.locator('#add-id-name').fill(typed)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
  }
  const fits = async (page, expect) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'the page is wider than its window')
  const said = (page) => page.locator('#add-id-result')
  const noRetry = async (page, expect, where) => {
    expect(await page.getByRole('button', { name: /try again|look again/i }).count() === 0, `${where} offers to try again`)
  }
  return {
    'me-old-range': {
      scenario: far, hash: '#/me', waitFor: '.add-id-section',
      run: async (page, expect) => {
        const text = await page.locator('.ids').textContent()
        expect(text.includes('This page looked back about 10 hours in the registry.'), 'the words do not say how far back the page looked')
        expect(text.includes('No ID found yet.') && text.includes('This page found no IDs held by this address.'), 'an empty list claims the address holds nothing')
        expect(await listed(page) === 0, 'a card is drawn for an ID nobody found')
        await noRetry(page, expect, 'a window that cannot reach old IDs')
        await fits(page, expect)
      }
    },
    'me-old-range-added': {
      scenario: far, hash: '#/me', waitFor: '.add-id-section',
      run: async (page, expect) => {
        await addByName(page, 'Alice.orv')
        await page.waitForSelector('article.id-card .record-list', { timeout: 30000 })
        expect(await page.locator('.notice.ok').textContent().then((words) => words.includes('alice.v1.orivonid.eth is in the list')), 'adding an ID does not say it is in the list')
        expect(await listed(page) === 1, 'the added ID has no card')
        expect(await page.evaluate((key) => localStorage.getItem(key), knownKey) === JSON.stringify({ version: 1, labels: ['alice'] }), 'the added ID is not remembered')
      }
    },
    'me-remembered': {
      scenario: far, hash: '#/me', storage: remembered(knownKey, 'alice', 'bob-1'), waitFor: 'article.id-card',
      run: async (page, expect) => {
        await page.waitForFunction(() => document.querySelectorAll('article.id-card .record-list').length === 2, null, { timeout: 30000 })
        expect(await page.locator('.ids').textContent().then((words) => words.includes('This address holds 2 IDs.')), 'the remembered IDs are not listed')
      }
    },
    'me-lapsed': {
      scenario: { ...far, taken: ['orivonfan'] }, hash: '#/me', storage: remembered(knownKey, 'alice', 'orivonfan'), waitFor: '.add-id-section',
      run: async (page, expect) => {
        await page.waitForSelector('#lapsed-title', { timeout: 30000 })
        await page.waitForSelector('article.id-card .record-list', { timeout: 30000 })
        const section = await page.locator('section[aria-labelledby=lapsed-title]').textContent()
        expect(section.includes('orivonfan.v1.orivonid.eth') && section.includes('another address'), 'a remembered ID the address lost is not named with why')
        expect(await listed(page) === 1, 'an ID the address does not hold is drawn as a card')
        await fits(page, expect)
      },
      after: async (page, expect) => {
        await page.getByRole('button', { name: 'Forget it' }).click()
        await page.waitForFunction(() => document.querySelector('#lapsed-title') === null, null, { timeout: 30000 })
        expect(await listed(page) === 1 && await page.locator('.working').count() === 0, 'forgetting an ID read the list again')
        expect(await page.evaluate((key) => localStorage.getItem(key), knownKey) === JSON.stringify({ version: 1, labels: ['alice'] }), 'a forgotten ID is still remembered')
      }
    },
    'me-add-refused': {
      scenario: { ...far, taken: ['orivonfan'] }, hash: '#/me', waitFor: '.add-id-section',
      run: async (page, expect) => {
        await addByName(page, 'orivonfan')
        await page.waitForFunction(() => document.querySelector('#add-id-result')?.textContent?.includes('not by this address') === true, null, { timeout: 30000 })
        await addByName(page, 'nobodyhere')
        await page.waitForFunction(() => document.querySelector('#add-id-result')?.textContent?.includes('no holder') === true, null, { timeout: 30000 })
        await addByName(page, 'a.b.c')
        await page.waitForFunction(() => document.querySelector('#add-id-result')?.textContent?.includes('Write the name as') === true, null, { timeout: 30000 })
        expect(await listed(page) === 0, 'a refused name was listed')
        expect(await page.evaluate((key) => localStorage.getItem(key), knownKey) === null, 'a refused name was remembered')
        expect((await said(page).textContent()).length > 0, 'a refusal says nothing')
      }
    },
    'me-logs-refused': {
      scenario: { ...RICH, logsRefused: true }, hash: '#/me', storage: remembered(knownKey, 'alice'), waitFor: 'article.id-card',
      run: async (page, expect) => {
        await page.waitForSelector('.notice.warn', { timeout: 30000 })
        const text = await page.locator('.ids').textContent()
        expect(text.includes('Your node could not show the registry’s recent activity.') && text.includes('add it by name'), 'a refused scan is not worded as what the page could not see')
        expect(await listed(page) === 1, 'the remembered ID is not listed when the logs are refused')
        await noRetry(page, expect, 'a refused scan')
        await fits(page, expect)
      }
    },
    'connect-old-range': {
      scenario: far, hash: connectHash(), waitFor: '.add-id-section', fold: true,
      run: async (page, expect) => {
        const text = await page.locator('.connect-body').textContent()
        expect(text.includes('You do not hold an ID that can sign in.') && text.includes('This page looked back about 10 hours in the registry.'), 'the empty consent screen does not say how far back it looked')
        await noRetry(page, expect, 'the consent screen')
        await fits(page, expect)
      },
      after: async (page, expect) => {
        await addByName(page, 'alice')
        await page.waitForSelector('.ids-pick input[type=checkbox]:checked', { timeout: 30000 })
        expect(await page.getByRole('button', { name: 'Sign in', exact: true }).isEnabled(), 'an ID added by name cannot be used to sign in')
        expect(await page.evaluate((key) => localStorage.getItem(key), knownKey) === JSON.stringify({ version: 1, labels: ['alice'] }), 'the ID added at the consent screen is not remembered')
      }
    },
    'connect-remembered': {
      scenario: far, hash: connectHash(), storage: remembered(knownKey, 'alice', 'bob-1'), waitFor: '.terms', fold: true,
      run: async (page, expect, viewport) => {
        await inView(page, expect, viewport)
        expect(await page.locator('.ids-pick input[type=checkbox]:checked').count() === 2, 'the remembered IDs are not offered, ticked')
        await sleep(100)
      }
    }
  }
}

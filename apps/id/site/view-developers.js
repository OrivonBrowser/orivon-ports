// The page for the people who build the other side: how a Web3site asks for an Orivon ID sign-in, in the order the
// calls are made, with the protocol served as a file of this site.

import { ACTION, ANSWER, ASK, COPY, FAILURE_WORDS, MANIFEST, RELYING_SITE_RULES, WORKS_IN } from './developers-model.js'
import { el } from './dom.js'
import { notice } from './parts.js'

/** @param {string} title @param {string} code */
const codeBlock = (title, code) => el('figure', { class: 'code' }, el('figcaption', { text: title }), el('pre', { tabindex: '0' }, el('code', { text: code })))

/**
 * @param {HTMLElement} root
 */
export function mountDevelopers (root) {
  root.append(el('div', { class: 'page narrow prose' },
    el('h1', { text: 'Sign in with an Orivon ID' }),
    el('p', {
      class: 'lede',
      text: 'A Web3site can ask a person which Orivon IDs their address holds, and can be given a key to check later requests against. ' +
        'The person answers on this site, with one signature. No server of Orivon’s sits between the two sites: your own page hands the request to this one, in the person’s browser.'
    }),
    el('section', { 'aria-labelledby': 'dev-copy' },
      el('h2', { id: 'dev-copy', text: '1. Copy the SDK' }),
      el('p', {
        text: 'The sdk folder of this site is the whole library, written as it runs. Serve it at /.well-known/orivon-id/ of your site, and import from there. ' +
          'To delegate a key, your manifest asks Orivon for one:'
      }),
      codeBlock('Your orivon.json', MANIFEST), codeBlock('Your build', COPY)),
    el('section', { 'aria-labelledby': 'dev-ask' },
      el('h2', { id: 'dev-ask', text: '2. Send the person here' }),
      el('p', {
        text: 'requestSignIn keeps the request in your own storage and gives back the address to navigate to. That address carries your origin ' +
          'and nothing else. The person presses Continue here, this site goes to your bridge page, and the bridge page brings the person back with the request it read from your storage, ' +
          'so no address anyone writes can name a key or a nonce.'
      }),
      codeBlock('On your page', ASK)),
    el('section', { 'aria-labelledby': 'dev-answer' },
      el('h2', { id: 'dev-answer', text: '3. Read the answer' }),
      el('p', {
        text: 'The bridge page receives the answer, takes it out of the address bar, keeps it in your storage and sends the person to the path you gave as after. ' +
          'takeAnswer reads it once. completeSignIn checks every step of the protocol against Ethereum, through the person’s own node, and names the one that fails.'
      }),
      codeBlock('On the page at after', ANSWER)),
    el('section', { 'aria-labelledby': 'dev-action' },
      el('h2', { id: 'dev-action', text: '4. Check later requests' }),
      el('p', {
        text: 'A sign-in is only good while it holds: a transfer of the ID, a changed address record, an expiry or “End all sign-ins” ends it. ' +
          'verifyAction checks all of that again each time, together with the key’s own signature.'
      }),
      codeBlock('On each request', ACTION)),
    el('section', { 'aria-labelledby': 'dev-rules' },
      el('h2', { id: 'dev-rules', text: '5. Keep your side safe' }),
      el('p', { text: 'The proof is only as good as the pages of yours that ask and answer. Your site must:' }),
      el('ul', {}, RELYING_SITE_RULES.map((rule) => el('li', {}, el('strong', { text: `${rule.title} ` }), el('span', { text: rule.words })))),
      el('p', {
        class: 'muted',
        text: 'This site knows who is asking from the browser, not from the link: it accepts a request only from your bridge page, reached by this site a moment before.'
      }),
      notice('info', 'Where sign-in works', el('p', { text: WORKS_IN }))),
    el('section', { 'aria-labelledby': 'dev-refusals' },
      el('h2', { id: 'dev-refusals', text: '6. What a refusal means' }),
      el('p', { text: 'completeSignIn and verifyAction answer { ok: false, failure } with one of these names, and a detail when there is more to say.' }),
      el('details', { class: 'refusals' },
        el('summary', { text: `All ${Object.keys(FAILURE_WORDS).length} refusals` }),
        el('dl', {}, Object.entries(FAILURE_WORDS).map(([name, words]) => el('div', {}, el('dt', {}, el('code', { text: name })), el('dd', { text: words })))))),
    el('section', { 'aria-labelledby': 'dev-learn' },
      el('h2', { id: 'dev-learn', text: 'What the person sees, and what you learn' }),
      el('ul', {}, [
        'Your site’s address, as the largest thing on the screen, so a look-alike cannot pass as you.',
        'The IDs their address holds, ticked by default. They may untick any. You learn only the ones they leave ticked.',
        'With a key: how long you may act as these IDs (they can shorten it), what that allows, and that it never allows moving funds.',
        'You learn their address, the IDs they shared, the time and, with a key, a P-256 key that differs for every site.'
      ].map((line) => el('li', { text: line })))),
    notice('info', 'The full protocol', el('p', {},
      el('a', { href: 'PROTOCOL.md', text: 'PROTOCOL.md' }),
      ' is the specification: the request, the message the person signs, the answer, every check in order, revocation, ' +
      'and what each side learns. Another team can build either side from it.'))))
}

// What the Developers page says: the code a relying site copies, the rules it must keep for the proof to mean anything
// (PROTOCOL.md section 9), and the words for each refusal `completeSignIn` and `verifyAction` name. Pure.

export const COPY = `# Serve the sdk/ folder of this site at /.well-known/orivon-id/ of your own site, unchanged.
# bridge.html in it is the one page the sign-in sends the person to; your app imports the rest from there.
# It has no dependencies and makes no request, so your site can stay at Web3 Score Level 4.`

export const ASK = `import { requestSignIn } from './.well-known/orivon-id/connect.js'

const url = await requestSignIn({
  delegate: true,                              // optional: ask for the key Orivon keeps for your origin, P-256
  ttl: 2_592_000,                              // seconds you ask the key to last, at most 180 days
  after: '/signed-in'                          // where the person lands afterwards: a path on your own site, '/' by default
}, { orivon })
location.assign(url)                           // the link carries your origin and nothing else
// The SDK keeps the request in your own localStorage, for the bridge page to read; one is in flight at a time.`

export const ANSWER = `import { completeSignIn, onAnswer, takeAnswer } from './.well-known/orivon-id/connect.js'

async function finish () {
  const answer = takeAnswer()                  // once; null when the bridge page left none
  if (answer?.kind === 'response') {
    const result = await completeSignIn(answer.response, { chain, now: Math.floor(Date.now() / 1000) })
    if (result.ok) {
      // result.address, result.names, result.key, result.notAfter
    } else {
      // result.failure names the check that failed, result.detail says more
    }
  } else if (answer?.kind === 'error') {
    // 'cancelled'
  }
}
await finish()                                 // on the page at \`after\`
onAnswer(finish)                               // and on the page that asked, when the person signed in through a new tab`

export const ACTION = `import { appKey, verifyAction } from './.well-known/orivon-id/connect.js'

const key = await appKey(orivon, { origin: location.origin })

// Later, for each request the key signed:
const signature = await key.sign(payload)      // payload is Uint8Array; the SDK frames it with your origin so it only ever reads as a request
const verdict = await verifyAction({ signIn: storedResponse, payload, signature, origin: location.origin, chain, now })`

export const MANIFEST = '"capabilities": { "id": { "curves": ["P-256"] } }'

/**
 * What a relying site must do, one entry per bullet of PROTOCOL.md section 9, in its order. `id` ties an entry to its bullet.
 * @type {readonly { id: 'bridge' | 'injection' | 'sdk' | 'payload', title: string, words: string }[]}
 */
export const RELYING_SITE_RULES = Object.freeze([
  {
    id: 'bridge',
    title: 'Serve the SDK’s bridge page, unchanged, at its fixed path.',
    words: 'The sign-in sends the person to /.well-known/orivon-id/bridge.html of your site, and that page hands your pending request to the ID site and ' +
      'takes the answer back. Serve the file from the sdk folder as it is: no rewrite, no redirect, no service worker that answers that path, and no ' +
      'other page there. A different page could pass the request to another site. Serve it at that exact path, with no pretty-URL rewrite: Cloudflare Pages redirects ' +
      'bridge.html to /bridge by default, and Netlify and Vercel do when pretty URLs are on, and a redirected page stops every sign-in. ' +
      'When the page is missing, the sign-in stops at your site, and nothing is signed.'
  },
  {
    id: 'injection',
    title: 'Keep other people’s script out of your pages.',
    words: 'Your pages decide what is asked: the key, the lifetime and where the person lands. Script injected into any page of yours can start a request ' +
      'from your own origin, with an attacker’s key in it. An open redirect elsewhere on your site no longer matters to the sign-in, and the key is read from ' +
      'Orivon by the SDK, never taken from an address.'
  },
  {
    id: 'sdk',
    title: 'Verify with this SDK, and give it your page’s own origin.',
    words: 'completeSignIn takes the pending request out of the store before it checks. Pass verifyAction the response it accepted, as it ' +
      'was stored, and nothing a request carries. Give appKey and verifyAction your own origin.'
  },
  {
    id: 'payload',
    title: 'Put a counter, a nonce or a time in the payload of each action.',
    words: 'The frame names your site, but the protocol does not stop a replay of an action to the same site.'
  }
])

/** Where the sign-in works, and what a browser that does not keep the address of the bridge page makes of it. */
export const WORKS_IN = 'Sign-in works in Orivon and in Chromium-based browsers. This site accepts a request only when the browser reports the exact address of your bridge page, ' +
  'and a browser that trims the address it tells other sites does not: there the sign-in stops here, with words, and nothing is signed.'

/** The words for every refusal `completeSignIn` and `verifyAction` give, by the name in `failure`. */
export const FAILURE_WORDS = Object.freeze({
  malformedResponse: 'The answer is not the object the protocol defines: its members, types, address spelling, signature size or names.',
  malformedMessage: 'The signed text is not an EIP-4361 message in the one written form.',
  wrongDomain: 'The message was not made for id.orivonstack.eth.',
  wrongAudience: 'The message names another site than yours.',
  wrongChain: 'The message is not for Ethereum mainnet.',
  wrongNonce: 'The nonce is not the one this request was made with.',
  wrongAddress: 'The address in the answer is not the address in the message.',
  wrongState: 'The state in the answer is not the one you sent.',
  badTimes: 'A time is badly written, or the expiry is not after the issue time.',
  notYetValid: 'The message was issued more than 5 minutes ahead of your clock.',
  expired: 'The message has expired.',
  badLifetime: 'The lifetime is not 10 minutes without a key, or not between 60 seconds and what you asked for with one.',
  badResources: 'The resources are not the usernames with their resolvers, then at most one key.',
  namesMismatch: 'The names in the answer are not the names in the message.',
  wrongStatement: 'The statement is not the one the protocol writes for this request.',
  notCanonical: 'The message is not what the protocol writes from its own fields, byte for byte.',
  keyMismatch: 'The key in the message is not the one you asked for, or a key came back when you asked for none.',
  badSignature: 'The signature is not the address’s. Detail highS: the second form of a signature (s in the upper half), which is refused.',
  notAttributed: 'The address does not own a username now. Detail: owner, roles, rolesUnreadable (the registry would not say) or forward:<problem>.',
  resolverChanged: 'The registry now names another resolver than the one the username was signed with. Detail: the current resolver.',
  recordsNotHeld: 'The address cannot write the username’s records on its resolver. Detail: notPermissionedResolver, textRoleMissing, addressRoleMissing or unreadable.',
  revoked: 'The owner ended every sign-in made up to a later time.',
  revocationUnreadable: 'The revocation record is not a whole number of seconds, so nothing is accepted.',
  chainUnavailable: 'The node could not answer. Nothing is proven, so nothing is accepted; try again.',
  noKey: 'The sign-in has no delegated key to check the action against.',
  badAction: 'The payload or the signature is not bytes of the right size.',
  badActionSignature: 'The key did not sign this payload for your site. Detail highS: the signature has s in the upper half, which is refused.',
  cryptoUnavailable: 'This page has no WebCrypto, which P-256 needs.',
  noPendingRequest: 'No request of this browser is waiting for an answer, or it is more than an hour old.'
})

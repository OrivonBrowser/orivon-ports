// What the Developers page says: the code a relying site copies, the rules it must keep for the proof to mean anything
// (PROTOCOL.md section 9), and the words for each refusal `completeSignIn` and `verifyAction` name. Pure.

export const COPY = `# Copy the sdk/ folder of this site into your own bundle, unchanged.
# It has no dependencies and makes no request, so your site can stay at Web3 Score Level 4.`

export const ASK = `import { appKey, requestSignIn } from './sdk/connect.js'

// Only to delegate a key: the key Orivon keeps for your origin, P-256. Give it the page's own origin.
const key = await appKey(orivon, { origin: location.origin })

const url = requestSignIn({
  returnUrl: location.origin + '/signed-in',   // https, no #; a page that only reads the answer, with no redirect behind it
  delegateKey: key.publicKey,                  // optional
  ttl: 2_592_000                               // seconds you ask the key to last, at most 180 days
})
location.assign(url)                           // a plain navigation, with the browser's default referrer policy
// The SDK keeps the request in localStorage, so a tab that is opened for the answer finds it; one is in flight at a time.`

export const ANSWER = `import { readResponse, completeSignIn } from './sdk/connect.js'

const answer = readResponse(location)          // removes the fragment from the address bar; null when there is none
if (answer?.kind === 'response') {
  const result = await completeSignIn(answer.response, { chain, now: Math.floor(Date.now() / 1000) })
  if (result.ok) {
    // result.address, result.names, result.key, result.notAfter
  } else {
    // result.failure names the check that failed, result.detail says more
  }
} else if (answer?.kind === 'error') {
  // 'cancelled' or 'invalid-request'
}`

export const ACTION = `import { appKey, verifyAction } from './sdk/connect.js'

const key = await appKey(orivon, { origin: location.origin })

// Later, for each request the key signed:
const signature = await key.sign(payload)      // payload is Uint8Array; the SDK frames it with your origin so it only ever reads as a request
const verdict = await verifyAction({ signIn: storedResponse, payload, signature, origin: location.origin, chain, now })`

export const MANIFEST = '"capabilities": { "id": { "curves": ["P-256"] } }'

/**
 * What a relying site must do, one entry per bullet of PROTOCOL.md section 9, in its order. `id` ties an entry to its bullet.
 * @type {readonly { id: 'redirect' | 'referrer' | 'sdk' | 'payload', title: string, words: string }[]}
 */
export const RELYING_SITE_RULES = Object.freeze([
  {
    id: 'redirect',
    title: 'Have no open redirect at or behind your return address.',
    words: 'The answer is a URL fragment, and a 3xx response keeps a fragment across the redirect. A path that forwards by a parameter ' +
      '(/out?to=, /logout?next=, a login page that returns to ?redirect=), or a script or meta refresh that does, hands the signed answer ' +
      'to whoever chose the target. Return to a page that serves itself and reads the fragment there.'
  },
  {
    id: 'referrer',
    title: 'Keep the browser’s default referrer policy on the navigation to this site.',
    words: 'A request that carries a key is refused when the referrer is not your origin, and a browser sends your origin by default. ' +
      'no-referrer, same-origin or any policy that drops it makes every delegation request fail with unknownOrigin. ' +
      'Make the request from a page on the origin your return address names.'
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
  noPendingRequest: 'No request of this tab is waiting for an answer, or it is more than an hour old.'
})

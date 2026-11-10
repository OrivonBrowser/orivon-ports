# Orivon ID sign-in, version 1

A Web3site (the relying site) asks a person to prove, in one signature, which Orivon ID usernames
(`<label>.v1.orivonid.eth`) their Ethereum address holds, and optionally to delegate a key it can
check later requests against. The person answers on the ID site, `https://id.orivonstack.eth`. The
proof is an EIP-4361 message signed by the person's wallet; the relying site checks it against the
chain, with no server of Orivon's in between. Everything travels in URL fragments, which a browser
never sends to a server.

Another team can implement either side from this page; section 9 says what a relying site must do for the proof to mean anything. `site/sdk/` is the reference relying side
(copy the folder whole); `site/connect-request.js` is the reference ID side.

## 1. The request

The relying site navigates the tab to

```
https://id.orivonstack.eth/#/connect?v=1&return=<url>&nonce=<nonce>[&state=<state>][&delegate=<key>&ttl=<seconds>]
```

Values are percent-encoded as `encodeURIComponent` does (a `+` is a plus). A field appears once;
a field not listed is refused. The ID site checks, in this order, and refuses with the name given:

| Field | Bounds | Refused as |
|---|---|---|
| fragment | begins `#/connect?`, every pair `name=value`, decodable, no repeated or unknown name | `notConnect`, `malformed`, `duplicate`, `unknownField` |
| `v` | `1` | `badVersion` |
| `return` | present; at most 2048 characters, all printable ASCII (a host outside ASCII is written in punycode); parsed as a URL; scheme `https`; a host; no `#` anywhere in it; no user name or password; an origin of at most 64 characters | `missingReturn`, `returnTooLong`, `returnNotAscii`, `returnNotUrl`, `returnNotHttps`, `returnHasFragment`, `returnHasCredentials`, `audienceTooLong` |
| `nonce` | present; 16 to 64 of `A-Za-z0-9`; unpredictable, used once | `missingNonce`, `badNonce` |
| `state` | optional; 1 to 256 of `A-Za-z0-9._~-` | `badState` |
| `delegate` | optional; `0x` and 66 hex digits: a NIST P-256 point, compressed (`02` or `03`, then x), on the curve | `badKey` |
| `ttl` | with `delegate`, and only then; decimal seconds, no leading zero, 60 to 15552000 (180 days) | `missingTtl`, `badTtl`, `ttlWithoutKey` |

The origin of `return` (scheme, host, a port when not 443) is the **audience**. It is at most 64
characters so that the statement of section 3, which names it in full, stays one short line that a person reads
at a glance.
A request that fails shows the reason in words. When `return` itself passed every check, and the arrival of
section 2 did too, the screen may offer to go back with `invalid-request` (section 4); otherwise it offers nothing
to navigate to.

The delegated key is the one Orivon gives an app for its own origin: `orivon.id.publicKey({ curve: 'P-256' })`
answers it as 65 uncompressed bytes, and the site sends it compressed (section 6 says why P-256).

## 2. What the ID site shows

**How the person arrived.** A request names the site it returns to and a key to delegate to, and nothing in it
says who put it in front of the person. So before it shows anything to sign, the ID site asks the browser, and
stops, with words, when:

- the page runs inside a frame (`framed`);
- the referrer is another origin than the audience (`wrongOrigin`: the person came from a page that is not the
  site they would sign in to);
- the referrer is empty and the request carries a key (`unknownOrigin`: a link from a mail or a chat, or a site
  that sends no referrer, cannot be told from an attacker's).

A plain sign-in, which delegates nothing, with an empty referrer goes on with a warning above Continue: "Only
continue if you just pressed Sign in on {audience}." When the screen stops, it offers no way to navigate to the
`return`, neither Cancel nor `invalid-request`: those go only to a `return` that passed every check, this one
included.

**What it shows to sign.** Nothing it shows is taken from `return` but the origin and the address:

1. The audience origin, as the largest thing on the screen, in the ASCII form of the host (the
   punycode form of an internationalised name), so a look-alike cannot read as the real one. Whenever
   `return` is more than the origin's root (any path or query), the whole address too, since a redirect hides
   behind a path.
2. The address that will sign, and the usernames that address holds now (the attribution rule of
   section 5, read on chain). The person ticks the ones to share, at least one and at most 16. A username that
   fails a clause is listed with the reason in words and what to do, and cannot be ticked.
3. With a key: that the site will be able to act as these usernames until a date, what that means
   (it accepts requests signed by the key as the person's; it cannot move funds), the lifetime
   (at most the `ttl`; the person may shorten it, to no less than 60 seconds), the first and last
   bytes of the key, and that "End all sign-ins" on the ID site ends it.
4. Without a key: that the site only learns which usernames the address holds, for ten minutes.
5. Cancel, which answers `cancelled`.

It signs nothing but the message of section 3, built from what was shown. Just before signing it
re-reads the attribution rule for each ticked username and checks that the wallet's address is the
one shown. After signing it checks the signature against the address (section 5, step 17) before it
navigates away.

## 3. The message

One EIP-4361 message, signed as an EIP-191 personal message over its UTF-8 bytes. The signature is
65 bytes: r, s, then v as 27 or 28. The message has exactly this form, with line feeds (`\n`) only,
no final line feed, no scheme before the domain, and no `Not Before` or `Request ID` line:

```
id.orivonstack.eth wants you to sign in with your Ethereum account:
{address}

{statement}

URI: {audience}
Version: 1
Chain ID: 1
Nonce: {nonce}
Issued At: {issued}
Expiration Time: {expires}
Resources:
- orivonid:name:{label}.v1.orivonid.eth#{resolver}
- orivonid:key:p256:{key}
```

| Field | Value |
|---|---|
| domain | `id.orivonstack.eth`: the page that asks for the signature |
| address | the signer, EIP-55 exactly as the checksum spells it |
| URI | the audience origin, as in section 1 (no path) |
| Version, Chain ID | `1`, `1` |
| Nonce | the request's |
| Issued At | now, written `YYYY-MM-DDTHH:MM:SSZ` (UTC, whole seconds) |
| Expiration Time | same spelling. Without a key: Issued At + 600 s exactly. With a key: Issued At + the lifetime chosen, 60 s to the `ttl` |
| Resources | one `orivonid:name:` line per shared username, 1 to 16, none twice, each label valid for the registrar (3 to 63 of `a-z0-9-`, no hyphen at either end, no `--` at the 3rd and 4th place, not `0x` and 40 hex digits), each followed by `#` and the resolver the registry named for the username when the person signed: `0x` and 40 lower-case hex digits, not the zero address; then, only when a key was asked, one `orivonid:key:p256:` line holding the key as the request spelled it but in lower case. The key line is last |

The domain names the page that asks the wallet to sign, so a wallet that compares a message's domain
with the origin asking (as EIP-4361 asks of wallets) refuses the same message from any other page. The URI is the
audience, which is not on the domain's site, so a wallet that checks the URI against the domain warns about every
sign-in made here (Orivon's wallet rates it High: the address it is for is not on the site it names). The protocol keeps
the two apart on purpose: the ID site signs in on behalf of the audience. Before the wallet opens, the consent screen
says that the warning will come, and why, and what to check: that the URI the wallet shows is the audience. It says it
directly above the Sign in button, in the bar that stays in view with it.

The **resolver** is the contract the username's records are on. Binding it into the signed text means the
sign-in speaks of those records and no others: when the registry later names another resolver for the username, the
sign-in is void (section 7).

The statement is one of two sentences, `{audience}` being the origin of the request. The first is used without a
key, the second with one:

```
Sign in to {audience}. It sees your usernames and cannot act as you.
```

```
Let {audience} act as you, with its own key, until expiry. It sees your usernames.
```

Orivon's wallet shows the statement, the URI and every resource whole, and rates a statement of more than 500
characters High, so the statement stays short: it names the audience and says first what a key does. With the
longest audience a request may carry (64 characters) the statements are 122 and 136 characters long. The usernames,
their resolvers, the key and the times are in the fields and the Resources, which the verifier checks against the
request; the person saw them on the ID site. Every other character
of the grammar of EIP-4361 (RFC 3986 for URI and statement characters, RFC 3339 for times) applies; a message is read
only if writing the fields it holds gives the same text byte for byte.

A filled example, with a key (the address is the EIP-712 example's "Cow"; the key is any P-256 point):

```
id.orivonstack.eth wants you to sign in with your Ethereum account:
0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826

Let https://app.example.org act as you, with its own key, until expiry. It sees your usernames.

URI: https://app.example.org
Version: 1
Chain ID: 1
Nonce: k3Jf92LmQp0xZ7aT
Issued At: 2026-11-06T12:00:00Z
Expiration Time: 2026-12-06T12:00:00Z
Resources:
- orivonid:name:alice.v1.orivonid.eth#0x7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e
- orivonid:name:bob-1.v1.orivonid.eth#0x4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b
- orivonid:key:p256:0x037cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978
```

## 4. The answer

The ID site navigates the tab to one of:

```
<return>#orivonid=<base64url(JSON)>
<return>#orivonid-error=<cancelled|invalid-request>[&state=<state>]
```

`<return>` is the canonical form of the request's `return` (its `href`). The base64url has no padding.
A message is at most 8192 bytes and a fragment at most 32768 characters.
The JSON is exactly these members, none other:

```
{ "v": 1, "message": "<the signed text>", "signature": "0x<130 hex digits>",
  "address": "<EIP-55>", "names": ["alice.v1.orivonid.eth", ...], "state": "<the request's>" }
```

`names` lists the message's usernames in its order; `state` is present only when the request had
one. `cancelled` answers a person who cancelled or whose wallet refused to sign; `invalid-request`
answers a request refused after `return` had passed. An error carries the request's `state`, if
there was one and it passed.

The relying site reads the fragment, removes it from the address bar and history
(`history.replaceState`), and treats anything it cannot read exactly as no answer. When the browser
refuses `replaceState`, the answer is still read and is marked as left in the address bar, for the page to say
so or navigate away. It keeps, for each request, the nonce, the audience, the key and the ttl it asked for and the
state it sent. It takes them out of its store before it verifies, so one answer cannot be presented twice, and puts
them back only when the node could not answer (`chainUnavailable`: nothing was decided, so the person may try
again); a verdict, good or bad, uses the request up.

## 5. Verifying a sign-in

In this order. A step that fails ends the check with the name given; none is skipped.

| # | Check | Failure |
|---|---|---|
| 1 | The answer is exactly the object of section 4 (members, types, EIP-55 address, 65-byte signature, names under `.v1.orivonid.eth`, at most 16) | `malformedResponse` |
| 2 | The message is a valid EIP-4361 message in the one written form | `malformedMessage` |
| 3 | No scheme, and domain is `id.orivonstack.eth` | `wrongDomain` |
| 4 | URI equals this site's own origin | `wrongAudience` |
| 5 | Chain ID is 1 | `wrongChain` |
| 6 | Nonce equals the one stored for the request | `wrongNonce` |
| 7 | The response's address is the message's | `wrongAddress` |
| 8 | The response's state is the one sent (absent if none was) | `wrongState` |
| 9 | Both times parse, are written as in section 3, Expiration is after Issued At | `badTimes` |
| 10 | Resources are as in section 3 (names, each with its resolver, then at most one key) | `badResources` |
| 11 | Lifetime: 600 s without a key; with one, 60 s to 15552000 s and no more than the ttl asked | `badLifetime` |
| 12 | Issued At is not more than 300 s after the verifier's clock | `notYetValid` |
| 13 | Expiration Time is after the verifier's clock | `expired` |
| 14 | The response's names are the message's | `namesMismatch` |
| 15 | The key in the message is the one asked for, and no key when none was asked | `keyMismatch` |
| 16 | The statement is the text of section 3, and the whole message equals the one rebuilt from the fields | `wrongStatement`, `notCanonical` |
| 17 | The signer (below) | `badSignature` |
| 18 | The attribution rule, for each username, now, and that the registry still names the resolver the username was signed with | `notAttributed`, `resolverChanged`, `recordsNotHeld` |
| 19 | The revocation record of each username, now | `revoked`, `revocationUnreadable` |

Steps 1 to 16 need no network. Any failure of the node to answer in steps 17 to 19 is
`chainUnavailable`: nothing is proven, so nothing is accepted.

**The signer (17).** The hash is `keccak256("\x19Ethereum Signed Message:\n" + decimal byte length + message)`.
The signature must have v 27 or 28 and s in the lower half of the order of secp256k1 (EIP-2): the second form of a
signature, `(r, n - s)` with v flipped, names the same signer and is refused (`badSignature`, detail `highS`). First,
`ecrecover`: an `eth_call` to the precompile at
`0x0000000000000000000000000000000000000001` with the 128 bytes hash, v as 32 bytes, r, s. An answer
of 32 bytes whose low 20 are the address proves it. Only if the answer is another address or empty,
and the address has code, the signature is accepted when `isValidSignature(bytes32,bytes)` on the
address (EIP-1271) returns `0x1626ba7e`; a revert or any other value is a refusal. An account that
delegates to code by EIP-7702 and signs with its own key is proven by `ecrecover` and its code is
never asked.

**The attribution rule (18).** An address X owns `<label>.v1.orivonid.eth` when all four hold,
read on chain at the time of use, through the node of the person or of the verifier:

- (a) `getOwner(uint256(keccak256(label)))` on the registry `0xDD1DecE58Eb7a5CebF8c1e0834b7eD4096e7ED20`
  is X;
- (b) `roleCount(id)` equals `roles(id, X)` on that registry. A read that reverts or answers something else is
  not zero: the clause fails as `rolesUnreadable`;
- (c) the registry's `getResolver(label)` is a resolver whose `addr(namehash(name))` is X, asked as ENSIP-10 says
  (`resolve(dnsEncode(name), addr call)` when the resolver declares `supportsInterface(0x9061b923)`, the call
  itself otherwise), with no off-chain lookup;
- (d) X can write the name's records on that resolver: `verifyContract(resolver)` on the VerifiableFactory
  `0x77510ba162dfeA3d8989E3f0928a691B345730D2` answers the PermissionedResolver implementation
  `0x565b0F456a04Ac9b48758190e90030623Cff57C5` (the factory vouches for the resolver, and answers the current
  implementation, so an upgraded resolver fails), and `hasRoles(resource, role, X)` on the resolver is true for the
  text role on the resource of the revocation key (`ROLE_SET_TEXT`, bit 4) and for the address role on the resource of
  coin type 60 (`ROLE_SET_ADDRESS`, bit 0). A PermissionedResolver adds the roles held on the argument's resource
  (`keccak256` of the key, or of the coin type as 32 bytes) to those held at the root, and checks them for the
  record's argument, never for the name: whoever holds a role there writes every name's record on that resolver.
  Failure detail: `notPermissionedResolver`, `textRoleMissing`, `addressRoleMissing` or `unreadable` (a role read
  that reverts).

A reverse record, a URL and a claim in the response prove nothing. Failure detail of a clause that fails:
`owner`, `roles`, `rolesUnreadable` or `forward:<problem>`, as `notAttributed`; (d) is its own failure,
`recordsNotHeld`. Clause (d) closes the gift: a name given away with the giver's resolver still pointing at the
recipient passes (a), (b) and (c) while the giver can end and restore the recipient's sign-ins at will. The
recipient is told to point the name at a resolver of their own, which the holder may always do (the registrar grants
the holder set-resolver with the roles that make it the holder) and which Orivon ID's My IDs page does in three
transactions ("Move to your own resolver"). A resolver that others also hold roles on still
lets them write the records; (d) says the holder can, not that nobody else can.

**The resolver binding (18).** The resolver in the message's Resources for the username must be the one the registry
names now. When it is not, the sign-in is refused as `resolverChanged` before (c) and (d), with the registry's
current resolver as the detail.

**Revocation (19)** is section 7.

## 6. Requests signed by the delegated key

The key is the person's key for the relying site's origin: the broker derives it from the person's
seed and the origin, silently, and answers `publicKey({ curve: 'P-256' })` with 65 bytes
(`04 || x || y`) and `sign({ curve: 'P-256', payload })` with 64 bytes: r then s, ECDSA over SHA-256
of the payload exactly as given, a random nonce, so s is in either half of the order. `secp256k1` is
not served, so version 1 has one curve, P-256; the curve name in the key resource (`p256`) is where
another would be named. P-256 is checked with WebCrypto (ECDSA, P-256, SHA-256), which is why the
SDK carries no curve library.

What is signed is `"orivonid:action:v1\n"` (ASCII), the audience origin of the site the request is for and a line
feed, followed by the payload. An origin has no line feed, so the frame reads one way; a signature made for any
other purpose with the same key never reads as a request, and one made for one site means nothing at another that
holds a sign-in for the same key. `appKey(orivon, { origin }).sign(payload)` does this, and keeps s in the lower
half of the order of P-256: a signature is `(r, s)` and `(r, n - s)` alike to ECDSA, so `verifyAction` refuses the
upper form (`badActionSignature`, detail `highS`), and a replay cache keyed on signature bytes cannot be missed by the
twin. A request carries the payload, the 64-byte signature, and the sign-in response as it
was accepted; the payload itself must carry what keeps it from being replayed (a counter or a
nonce, a time), because the protocol does not.

On each request the relying site checks, in this order: the inputs; steps 1 to 16 of section 5 on
the stored response, with the nonce and state left out, the audience being this site's origin
(a sign-in made for another site never authorises a request here, even though its key is valid);
a key is present; the signature, in its lower form, over the payload framed with this site's origin against that key; then steps 17 to 19 again,
read now. A request is honoured only while all of it holds, so a transfer, a changed address record,
an expiry or a revocation since the sign-in ends it. The failures are those of section 5 and
`badAction` (the inputs are not bytes of the right size), `noKey`, `badActionSignature`,
`cryptoUnavailable` (no WebCrypto on the page).

## 7. Revocation, and what voids a sign-in

The owner of a username ends every sign-in made no later than a moment by setting the text record
`eth.orivonstack.id.not-before` on the resolver the registry names for the username
(`setText(bytes dnsName, string key, string value)`) to that moment in decimal unix seconds.
"End all sign-ins" on the ID site sets the current time plus 300 seconds (the allowance of step 12 for a verifier's
clock behind the signer's), so a sign-in issued up to then by a fast clock ends too. A sign-in is void when its
Issued At is less than or equal to the record; one made after it stands. A person who ends all sign-ins therefore
cannot sign in again to the same username for five minutes: the consent screen lists the username as unable to sign in
until then, with the time it can again. An empty record or `0` is none; a value that is not a
whole number of seconds (leading zero, sign, text, more than 16 digits) is `revocationUnreadable`, and refuses, so a
mistake never silently re-opens a sign-in. The ID site offers the call only to a holder who can send it (clause (d) of
section 5).

A sign-in is void when any of these holds, and a sign-in covers all its usernames, so one failing
username voids it: the username is transferred (attribution a); another account is given a role on
it (b); its address record no longer gives the signing address (c); its records can no longer be written by the
address (d); its registration ends (a); the Expiration Time passes; the owner sets the record. A contract wallet that
no longer vouches for the signature (EIP-1271) is void by step 17.

**Changing the resolver ends a sign-in.** The sign-in names the resolver the username's records were on; when the
registry names another, the sign-in is void (`resolverChanged`), and so is a revocation that sat on the old one,
whose record the verifier no longer reads. Pointing the name back at the old resolver restores the sign-in and its
revocation together.

**A transfer away and back revives a sign-in that was not revoked.** Nothing on chain says a username left and came
back, so a sign-in the owner did not revoke is honoured again when the name returns to the address, until it expires.
Revoke before transferring a username: the record stays on the resolver while the name is away, and it still ends the
sign-ins when the name is back.

## 8. What the relying site learns

The address, and with it everything public about it on the chain. The usernames the person ticked;
those it did not tick stay unlisted, though the chain lists them for anyone who reads it. The time,
and the lifetime. With a key, the person's P-256 public key for that origin, which differs for every
site, so two sites cannot link a person by it. The signature. It learns nothing of the person's other
sites. No server of Orivon's sees a request or an answer: the ID site is a page that runs on the
person's own computer, the request and the answer are in fragments, and the only network traffic is
the person's own node. A verifier that reads the chain (steps 17 to 19) tells its node provider
which usernames it is checking; a verifier using the person's own light client in the page tells the
execution server behind that client, which sees every slot and call it is asked for.

## 9. What a relying site must do

The proof is only as good as the way the person reached the ID site and the way the answer reached the relying
site. The relying site must:

- **Have no open redirect at or behind its `return` path.** The answer is a URL fragment, and a 3xx response keeps a
  fragment across the redirect, so any path under the `return` that forwards to another address by a parameter
  (`/out?to=`, `/logout?next=`, a login page that returns to `?redirect=`) hands the signed answer to whoever chose that
  address. A client-side redirect (a script, a meta refresh) hands it over too. Choose a `return` that serves a page and
  nothing else, and read the fragment there. The ID site shows the person the whole `return` address when it is more
  than the origin's root, which helps a person who looks and does not protect one who does not.
- **Keep the browser's default referrer policy on the navigation to the ID site.** The ID site refuses a request that
  carries a key when the referrer is not the audience, and the browser sends the referrer's origin by default
  (`strict-origin-when-cross-origin`). `no-referrer`, `same-origin` or any policy that drops it on a cross-origin
  navigation makes every delegation request fail with `unknownOrigin`. The request must also be made from a page of
  the audience's own origin, the one `return` names.
- **Verify with this SDK, never by hand.** `requestSignIn` keeps the request in `localStorage` (`sessionStorage` where
  that is blocked), so the tab that receives the answer finds it even when another tab asked: Orivon opens another
  app's origin in a tab of its own. One request is in flight at a time, and one older than an hour is ignored.
  `completeSignIn` takes the pending request out of the store before it
  checks, compares every field, and puts the request back only when the node could not answer. Pass `verifyAction` the
  response that `completeSignIn` accepted, as it was stored, and nothing a request carries: it does not ask for the nonce
  again, so a response no session of the site asked for is honoured if it is handed over. Give `appKey` and
  `verifyAction` the page's own origin.
- **Put the payload of each action to its own use.** The frame names the audience; the payload must carry a counter, a
  nonce or a time, because the protocol does not stop a replay of an action to the same site.

**What stays at risk.** A relying site with an open redirect at its return path, or with script injection (which can
start a request from its own origin, with a referrer that matches, and with an attacker's key), can lose sign-ins to
whoever uses it: the delegation then lasts until its expiry, and the person can end it with "End all sign-ins". A
relying site that does what is written above is as safe as its own pages. The ID site cannot tell more than the browser
tells it.

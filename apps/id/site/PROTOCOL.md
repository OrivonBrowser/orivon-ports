# Orivon ID sign-in, version 2

A Web3site (the relying site) asks a person to prove, in one signature, which Orivon ID usernames
(`<label>.v1.orivonid.eth`) their Ethereum address holds, and optionally to delegate a key it can
check later requests against. The person answers on the ID site, `https://id.orivonstack.eth`. The
proof is an EIP-4361 message signed by the person's wallet; the relying site checks it against the
chain, with no server of Orivon's in between. The relying site keeps its request in its own storage in
the person's browser and hands it to the ID site through one page of its own, the bridge, so no link
that anyone writes can name a key, a nonce or a place to go back to. The answer travels in a URL
fragment, which a browser never sends to a server.

Another team can implement either side from this page; section 9 says what a relying site must do for the proof to mean anything. `site/sdk/` is the reference relying side
(serve the folder whole at `/.well-known/orivon-id/`); `site/connect-request.js` is the reference ID side.

## 1. The request

The sign-in is five navigations of one tab, R being the relying site and ID the ID site:

1. R sends the person to `ID/#/connect?v=2&aud=<R>`: the link carries the audience and nothing else.
2. The person presses Continue on ID. ID makes a challenge and sends the tab to `R/.well-known/orivon-id/bridge.html?c=<challenge>`.
3. R's bridge page reads the request R kept and sends the tab back to ID with it and the challenge.
4. ID checks that the challenge is its own and that the browser says the bridge page sent the person, shows the consent screen and, when the person signs, sends the tab to the bridge page with the answer.
5. The bridge page keeps the answer for R's page and sends the tab to the path R chose.

**Ask.** The relying site keeps the whole request in its own `localStorage` (one in flight; `sessionStorage` where
that is blocked) and navigates the tab to

```
https://id.orivonstack.eth/#/connect?v=2&aud=<audience>
```

where `<audience>` is percent-encoded as `encodeURIComponent` does. The kept request is
`orivonid.pending = { v: 2, origin, nonce, key, ttl, state, after, at }`: `nonce` 32 characters of `A-Za-z0-9` from the
browser's random source, `key` and `ttl` null without a delegation, `after` a path on the relying site where the
person lands (`/` and then no `/` or `\`, printable ASCII, at most 2048 characters), `at` unix seconds. The key is the one Orivon
gives the page for its own origin (`orivon.id.publicKey({ curve: 'P-256' })` answers it as 65 uncompressed bytes, sent
compressed; section 6 says why P-256): the SDK reads it itself and never takes it from an argument, so no page of the relying
site can pass a key it was given in an address. The request may be made in the tab or in a new tab.

**The arrival.** `v` is `2`; `aud` is the audience. A field not listed is refused. The ID site checks, in this order,
and refuses with the name given. A link that carries a `c` is a confirmation, read as the table below says; any other is an arrival.

| Field | Bounds | Refused as |
|---|---|---|
| fragment | begins `#/connect?`, every pair `name=value`, decodable, no repeated name | `notConnect`, `malformed`, `duplicate` |
| `v` | `2`. A link with `v=1` is the older sign-in | `badVersion`, `olderVersion` |
| other fields | an arrival has `v` and `aud` only | `unknownField` |
| `aud` | present; an https origin written as a URL writes it (lower-case host, no default port, no path, no user name or password, no `#`), all printable ASCII (a host outside ASCII is written in punycode), at most 64 characters | `missingAudience`, `audienceNotAscii`, `audienceNotUrl`, `audienceNotHttps`, `audienceNotOrigin`, `audienceTooLong` |

The audience is at most 64 characters so that the statement of section 3, which names it in full, stays one short line
that a person reads at a glance. The ID site answers a link with `v=1` with "This site uses an older sign-in; ask
{audience} to update", the audience being the origin of its `return` when that is a plain https origin, and navigates nowhere.

**The confirmation.** The bridge page sends the person back with

```
https://id.orivonstack.eth/#/connect?v=2&c=<challenge>&nonce=<nonce>[&state=<state>][&delegate=<key>&ttl=<seconds>]
https://id.orivonstack.eth/#/connect?v=2&c=<challenge>&none=1
```

built from the kept request alone, by the bridge page of section 4. Values are percent-encoded as `encodeURIComponent` does. A field appears once.

| Field | Bounds | Refused as |
|---|---|---|
| other fields | a confirmation has `v`, `c`, `nonce`, `state`, `delegate`, `ttl`, `none` only | `unknownField` |
| `c` | present; 32 of `A-Za-z0-9` | `badChallenge` |
| `none` | `1`, and then no field but `v` and `c` | `badNone` |
| `nonce` | present; 16 to 64 of `A-Za-z0-9`; unpredictable, used once | `missingNonce`, `badNonce` |
| `state` | optional; 1 to 256 of `A-Za-z0-9._~-` | `badState` |
| `delegate` | optional; `0x` and 66 hex digits: a NIST P-256 point, compressed (`02` or `03`, then x), on the curve | `badKey` |
| `ttl` | with `delegate`, and only then; decimal seconds, no leading zero, 60 to 15552000 (180 days) | `missingTtl`, `badTtl`, `ttlWithoutKey` |

A link that is refused shows the reason in words and offers nothing to navigate to.

## 2. What the ID site shows

**The arrival.** The screen names the audience and offers Continue and Cancel; it reads no referrer. It refuses to run in a
frame. Continue is a press, never automatic: a first visit raises the ID site's install question on this page, and
granting it reloads the tab as the app, so the challenge is made only once the page is the app and can read the chain.
Continue makes the challenge, 32 characters of `A-Za-z0-9` from `crypto.getRandomValues`, stores
`sessionStorage['orivonid.challenge'] = { c, aud, at }` in the tab, replacing any earlier one, and navigates the tab, replacing
the page in the history, to

```
<audience>/.well-known/orivon-id/bridge.html?c=<challenge>
```

Cancel navigates to the bridge page with `#orivonid-error=cancelled`, which tells the page that asked.

**How the person came back.** A confirmation names no site: the audience is the one the challenge was made for. So before it
shows anything to sign, the ID site checks, in this order, and stops, with words and no way back to the relying site, at the
first that fails:

| # | Check | Refused as |
|---|---|---|
| 1 | The page is not in a frame | `framed` |
| 2 | `v` is `2` and the fields parse (section 1) | the name in section 1 |
| 3 | The tab holds a challenge, made at most 120 seconds ago; it is removed now, whatever follows | `noChallenge`, `challengeExpired` |
| 4 | `c` equals the stored challenge | `wrongChallenge` |
| 5 | `document.referrer` equals `<audience>/.well-known/orivon-id/bridge.html?c=<challenge>`, byte for byte | `notFromBridge` |
| 6 | The link does not say `none` | `notStarted`: "No sign-in was started on {audience} in this browser. Go to {audience} and press Sign in there." |

The referrer is the one thing in this channel that names its sender without the sender's say-so: the bridge page asks for
the full address of itself to be sent (`unsafe-url`), and the browser writes it. A page of the relying site that redirects
by script sends its own address, never the bridge page's, so it cannot pass step 5; and the challenge is made in the person's
ID tab, never in a link, so it cannot be guessed or learned before it is used.

**What it shows to sign.** Nothing it shows is taken from a link but the audience, and the audience is the one the person pressed Continue for:

1. The audience origin, as the largest thing on the screen, in the ASCII form of the host (the
   punycode form of an internationalised name), so a look-alike cannot read as the real one.
2. The address that will sign, and the usernames that address holds now (the attribution rule of
   section 5, read on chain). The person ticks the ones to share, at least one and at most 16. A username that
   fails a clause is listed with the reason in words and what to do, and cannot be ticked.
3. With a key: that the site will be able to act as these usernames until a date, what that means
   (it accepts requests signed by the key as the person's; it cannot move funds), the lifetime
   (at most the `ttl`; the person may shorten it, to no less than 60 seconds), the first and last
   bytes of the key, and that "End all sign-ins" on the ID site ends it.
4. Without a key: that the site only learns which usernames the address holds, for ten minutes.
5. Cancel, which answers `cancelled`.

A person who holds no username that can sign in registers one and comes back to the arrival, and presses Continue again: a
challenge is used once.

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

## 4. The answer, and the bridge page

**The bridge page** is `/.well-known/orivon-id/bridge.html` of the relying site, provided by the SDK and served
unchanged. It has `<meta name="referrer" content="unsafe-url">`, loads one SDK module and nothing else, and does nothing in a
frame. It runs as the relying site in the person's browser, so it reads the request the site kept. Two visits:

*From the ID site, with `?c=<challenge>`* (nothing else in the query). It goes on only when `document.referrer`
is the ID site's origin (`https://id.orivonstack.eth`) and `c` is 32 of `A-Za-z0-9`. It reads `orivonid.pending`: when there
is none, it is older than an hour, it is not for this origin or its fields do not pass the bounds of section 1, it navigates,
replacing the visit in the history, to the confirmation with `&none=1`; otherwise to the confirmation with exactly the
kept `nonce`, `state`, `key` (as `delegate`) and `ttl`.

*From the ID site, with the answer in the fragment.* It takes the fragment out of the address bar and the history before
anything else runs. It goes on only when `document.referrer` is the ID site's origin, as for the first visit: a visit from any
other page stores nothing, leaves the kept request as it is and does not navigate, so a page that sends the person to the
bridge with an answer of its own cannot end or answer a request. It then reads the fragment. It keeps the answer only when a request is kept (at most an hour old, for this origin) and,
for a response, the nonce in its message is the kept request's; for `cancelled` a `state`, when given, is the kept request's.
Anything else is dropped, not stored, and the kept request stays. A kept answer is written to `orivonid.answer = { answer, at }`
in `localStorage`, a message `{ kind: 'answer' }` is posted on `BroadcastChannel('orivonid')` for the tab that asked, and the
page navigates, replacing itself in the history, to the request's `after`. Whatever else it dropped, it navigates to `after`, or to `/`
when no request was kept. A cancellation also ends the kept request.

**The answer.** The ID site navigates the tab, replacing its page in the history, to one of

```
<audience>/.well-known/orivon-id/bridge.html#orivonid=<base64url(JSON)>
<audience>/.well-known/orivon-id/bridge.html#orivonid-error=cancelled[&state=<state>]
```

The base64url has no padding. A message is at most 8192 bytes and a fragment at most 32768 characters.
The JSON is exactly these members, none other:

```
{ "v": 1, "message": "<the signed text>", "signature": "0x<130 hex digits>",
  "address": "<EIP-55>", "names": ["alice.v1.orivonid.eth", ...], "state": "<the request's>" }
```

`names` lists the message's usernames in its order; `state` is present only when the request had
one. `cancelled` answers a person who cancelled or whose wallet refused to sign.

The relying site's page reads the answer with `takeAnswer()`, which removes it from the store as it reads it, so it is
read once; the page at `after` calls it when it loads, and a page that asked in another tab calls it when `onAnswer`
hears the channel. It treats anything it cannot read exactly as no answer. It keeps, for each request, the nonce, the audience,
the key and the ttl it asked for and the state it sent. `completeSignIn` takes them out of its store before it verifies, so
one answer cannot be presented twice, and puts them back only when the node could not answer (`chainUnavailable`: nothing
was decided, so the person may try again); a verdict, good or bad, uses the request up.

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
person's own computer, the request stays in the relying site's own storage, the answer is in a fragment, and the only
network traffic is the person's own node. A verifier that reads the chain (steps 17 to 19) tells its node provider
which usernames it is checking; a verifier using the person's own light client in the page tells the
execution server behind that client, which sees every slot and call it is asked for.

## 9. What a relying site must do

The proof is only as good as the pages of the relying site that ask and answer, and the bridge page between them. The relying
site must:

- **Serve the SDK's bridge page, unchanged, at its fixed path.** The sign-in sends the person to
  `/.well-known/orivon-id/bridge.html` of the site, and that page hands the kept request to the ID site and takes the answer
  back. Serve `sdk/` whole at `/.well-known/orivon-id/`, with no rewrite, no redirect, no service worker that answers that
  path, and no other page there: a different page could pass the request to another site, or the answer. Serve it at that
  exact path, with no pretty-URL rewrite: Cloudflare Pages redirects `bridge.html` to `/bridge` by default, and Netlify and
  Vercel do when pretty URLs are on. The address the browser reports then is not the one section 2 step 5 compares, and every
  sign-in stops there. When the page is missing, the sign-in stops at the site and nothing is signed.
- **Keep other people's script out of your pages.** The pages decide what is asked: the key, the lifetime and where the person
  lands. Script injected into a page of the site can write a request from the site's own origin, with an attacker's key in
  it. A redirect elsewhere on the site, by 3xx or by script, does not change the sign-in: nothing in it travels through a
  page of the site's choosing except the bridge page.
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

**What stays at risk.**

- *The relying site's documents.* Script injection on the site, a service worker it registered that answers the bridge path,
  or a bridge path it serves with something else can write a request or forward the challenge. The ID site cannot read the
  site's files, so the protocol cannot know what is served there.
- *The person's own request, surfaced by someone else.* Anyone can open `ID/#/connect?v=2&aud=<audience>` in the person's
  browser; when the person pressed Sign in on that site within the hour and did not finish, the consent screen shows that
  request, for the person's own key. Nothing is gained by it.
- *A look-alike relying site* with its own bridge page gets a sign-in for its own audience, shown in punycode as large as any
  other. The person checks the audience.
- *What the answer reveals if it leaks:* the person's address and the usernames ticked, not authority. The delegation names the
  key of the person at that site, which signs only in the person's browser, and in any other browser `completeSignIn` finds
  no request with the answer's nonce.
- *A browser that trims the referrer.* Sign-in is built for Orivon and for Chromium-based browsers, which send the full address of
  the bridge page when it asks for `unsafe-url`. A browser that sends none (a privacy setting or an extension) or trims a cross-site
  referrer to the origin stops every sign-in at step 5 of section 2, with words, and nothing is signed.
- *One more round trip* than a popup would need: about 160 ms in Orivon, and one press of Continue.

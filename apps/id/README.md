# `apps/id/`: Orivon ID, a name that signs you in

## About this page

**Orivon ID is a page where a person buys a username under `v1.orivonid.eth` and reads which usernames an address holds. It is written by Orivon in this repository and is not a port.**

| | |
|---|---|
| Version | 0.1.0 |
| Source | This directory: [`recipe.json`](recipe.json), [`orivon.json`](orivon.json), [`site/`](site/) |
| Licence | This repository's, [AGPL-3.0-only](../../LICENSE) |
| In another browser | The page works there when a wallet extension is installed (`window.ethereum`). Reading names needs no wallet inside Orivon. |
| Updates | Written in this repository, so a change here is the update; there is no schedule. |
| Problems | [Report a problem with this page](https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=Orivon%20ID): it goes to this repository's issue form. |

The sections below are for people working on the page.

**What lives here.** The code that reaches Ethereum for Orivon ID and reads the ENSv2 registry the
usernames live in. The page reaches Ethereum only through the Orivon standards `ETH_NET_0_1_READONLY`
(the person's light client), `ETH_NET_0_1` (broadcast) and `ETH_0_1` (the address and signatures), or
through `window.ethereum` in another browser. The one network host it declares is `rpc.flashbots.net`,
for the optional private send of a registration (section Registration). It is a `site` recipe, served
as `id.orivonstack.eth` in development.

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json) | A `site` recipe: port 8898, served as `id.orivonstack.eth` |
| [`orivon.json`](orivon.json) | The manifest: the three Ethereum standards, and the one optional `https.connect` host of the private send |
| [`site/sdk/bytes.js`](site/sdk/bytes.js), [`keccak.js`](site/sdk/keccak.js) | Pure: hex and byte helpers, Keccak-256 |
| [`site/sdk/abi.js`](site/sdk/abi.js) | Pure: ABI encode and decode (address, bool, uint, bytesN, string, bytes, tuples, arrays), selectors, event topics and logs, revert data, EIP-55 |
| [`site/sdk/ens.js`](site/sdk/ens.js) | Pure: `namehash`, `labelhash`, DNS wire encoding |
| [`site/sdk/chain.js`](site/sdk/chain.js) | The one `Chain` interface the page uses, the named failure reasons, block and quantity spelling, receipt polling, fee suggestion |
| [`site/sdk/chain-orivon.js`](site/sdk/chain-orivon.js) | The Chain over `orivon.use`, asking for each code the first time a call needs it, the queue its reads go through (`callQueue`), and the nonce book (`nonceAfter`, `noteBroadcast`) |
| [`site/sdk/chain-eip1193.js`](site/sdk/chain-eip1193.js) | The Chain over an EIP-1193 provider (`window.ethereum`) |
| [`site/sdk/chain-detect.js`](site/sdk/chain-detect.js) | Picks the adapter: Orivon when `orivon.use` exists, else the extension, else a `noWallet` error |
| [`site/sdk/orivonid.js`](site/sdk/orivonid.js) | The registry: addresses, label rules and prices, the sale status, who owns a label, whether a name may sign in as an address, a name's records, and the names an address holds |
| [`site/sdk/read.js`](site/sdk/read.js) | Contract reads through a Chain: one call, a decoded call, a name's resolver called as ENSIP-10 says, and a name's records asked together (`readProfiles`) |
| [`site/register-tx.js`](site/register-tx.js), [`register-reads.js`](site/register-reads.js), [`register-decoys.js`](site/register-decoys.js), [`register-reasons.js`](site/register-reasons.js), [`register-flow.js`](site/register-flow.js), [`register-send.js`](site/register-send.js), [`relay.js`](site/relay.js) | Registration (section Registration) |
| [`site/index.html`](site/index.html), [`style.css`](site/style.css), [`main.js`](site/main.js), [`icon.svg`](site/icon.svg) | The page (section The interface) |
| [`test/`](test/) | Unit tests, and fork tests that need `anvil`. Never served |

## Running the tests

```bash
npx vitest run apps/id        # unit tests; fork tests run when anvil and a public archive node are reachable
```

The fork tests start their own `anvil` on a free port, forked from Ethereum mainnet at one pinned
block, and skip with a printed reason when `anvil` (Foundry) is not installed or no public node can
serve that block's state and its logs. `ORIVON_ID_FORK_RPC` names a node to try first; after it come `rpc.flashbots.net` and `rpc.mevblocker.io`, which keep old state and answer log queries (`ethereum.publicnode.com` refuses state older than about 128 blocks). They buy a
name for real against the deployed registrar: the buyer is a derived address that is impersonated,
because the well-known anvil accounts carry an EIP-7702 delegation on mainnet and a mint to one
reverts.

## Registration

A registration is five transactions in an order the chain enforces, driven by a state machine that
survives a reload.

| File | What it is |
|---|---|
| [`site/register-tx.js`](site/register-tx.js) | Pure calldata builders: `commitTx`, `approveTx`, `deployResolverTx`, `registerTx`, `recordsTx` (the address record and the texts in one `multicall`), `receiverCheck`, the constants (`SALT`, the role bitmaps, the commitment ages, `REGISTER_GAS_LIMIT`), `withMargin` |
| [`site/register-reads.js`](site/register-reads.js) | `checkRegistration` (everything that can stop a sale, before any send), `resolverFor` (reuse or deploy the account's resolver), `predictedResolver`, `receiverOk`, `observe` (the chain's truth for one registration) |
| [`site/register-decoys.js`](site/register-decoys.js) | `createHider` (asks about a short label among decoys), `decoysFor`, `SEARCH_WORDS` (the sentence a page shows beside the search) |
| [`site/register-reasons.js`](site/register-reasons.js) | `REASONS` (a name, whether the person can `edit`, `retry` or nothing, and words), `reasonOfError`, `revertReason` (each registrar revert string) |
| [`site/register-flow.js`](site/register-flow.js) | `createRegistration`, the pure `decide`, `serialPerAccount`, the stored record (`readRec`, `parseRec`) |
| [`site/register-send.js`](site/register-send.js) | `orivonBroadcaster` (signs with `ETH_0_1`, keeps the hash apart from the send) and `walletBroadcaster` |
| [`site/relay.js`](site/relay.js) | `createRelay`, the Web2 words for the switch, `advisePrivate` |

**The order.** `commit`, then (while the commitment matures) the DAI `approve` and the resolver
`deployProxy` when they are missing, then `register` at the first block whose timestamp is at least
`commitmentAt + 60`, then the records. The resolver of an account is always at
`predictProxyAddress(account, SALT)`; it is reused when its code is there, `verifyContract` returns
the PermissionedResolver implementation and the account holds the roles `setAddress` and `setText`
need, and deployed otherwise. A commitment older than a day is void, and the flow starts again with a
new secret.

**The states** (`createRegistration(...).state()` and `onState`), and what a page draws for each:

| `phase` | Draw |
|---|---|
| `checking` | A wait; `what` says `name`, `sale` or `chain` |
| `ready` | The price, the balance, the transactions to come (`transactions`, `needs`) folded to one line that opens into the list, the private-send switch (`advisePrivate` for 3 and 4 letters), and a Register button that stays at the foot of the window |
| `committing`, `revealing`, `recording` | The step, with `sending`: `estimating`, `signing`, `broadcasting` or `mining` |
| `maturing` | A countdown from `secondsToMaturity`, which counts block timestamps, with `step` while an approve or deploy is sent beside it |
| `verifying` | A wait while the page reads the attribution back |
| `done` | The name and the `hashes` of each step |
| `failed` | `REASONS[reason].words` and `detail`, a button by `recover` (`edit` goes back to the name, `retry` calls `retry()`), the `hash` of a send that may still be mined, and `offerPublic` when the private relay refused. `recordDiscarded` (from `resume()`) carries `mismatch`, which names what the stored record got wrong |

A state made before the name is held carries `transactions` too: the plan the chain implies (the approval when
the allowance falls short of the price, the resolver when no code is at its address), so a page that was reloaded
draws every step from the first state. Once the name is held the chain no longer says what was needed, and a
step that left a hash stays listed by it.

The flow is `check(input)`, `start({ private, texts })`, `resume()` (on load: the stored record is
read back and the chain says where it stood), `retry({ private })`, `forget()`. One send runs at a
time per account, and the secret and each hash are stored before the send they belong to.

**The private send.** The switch is off. Turning it on calls `relay.allow()`, which holds the
`https.connect` grant on `rpc.flashbots.net:443` that [`orivon.json`](orivon.json) declares, or asks Orivon
for it; a refusal leaves it off. Orivon does not ask again for a host the person declined at install or whose
install question was closed, so the note beside the switch says where it is allowed: the key in the address
bar, then the row "Connect to rpc.flashbots.net" (or "Review permissions" for a site that was never let in). Only the `register` transaction goes that way: the page posts the bytes `ETH_0_1`
signed to `https://rpc.flashbots.net` as `eth_sendRawTransaction`, with its own `fetch`, no cookies
and no referrer. A failure is reported with the relay's words and the page offers `retry({ private:
false })`, which sends the same signed bytes publicly; nothing falls back by itself. The switch wears
the Web2 mark (`RELAY_WORDS.mark`) because a server sees the transaction and the address before it is
public.

**What the person's node learns about the label.** Inside Orivon the node is a light client, and the
execution server behind it sees every slot and call it is asked for, so a label is kept from it until it
cannot help anyone to take the name.

- A 3- or 4-letter label is asked about (who holds it, and for an account with code, whether the account
  takes the token) among 7 other valid labels of the same length and shape, drawn at random and asked in a
  random order; the decoys' answers are dropped. A repeated search for one label keeps its decoys, because two
  fresh sets would share only the real label. A longer label has too many spellings to try and is asked alone.
  A page shows `SEARCH_WORDS` beside the search. A decoyed search is 8 reads, so a page searches when the person
  submits, not at every key.
- From the commit until the commitment is old enough to reveal, the flow asks the node for the commitment's
  age, the account's DAI allowance, the resolver's code and the block's time, and nothing that names the
  label. The label's holder is read once the commitment can be revealed, and after a commitment has been spent.
- A reveal that goes to the private relay is signed with `REGISTER_GAS_LIMIT` and never estimated: an
  estimate would hand the node the label and the secret before the relay has them. The most a reveal used on
  a fork was 349,335 gas (a label of 63 bytes); the limit is a quarter above that. A reveal that goes out
  publicly is still estimated, which also stops a sale the registrar would refuse before gas is spent; the
  private one has no such check, and a sale refused after signing is mined as a revert.

**Nonces.** `ETH_NET_0_1` answers the count of mined transactions (`latest`) and refuses `pending`, so
the senders ask for `latest` and take the greater of it and one past the last nonce this page broadcast for
the account, kept in memory by `nonceAfter` and `noteBroadcast`. A broadcast that failed outright, or was
never sent, is not counted; one that timed out is. A reload starts again from the node's count.

**Reads are queued.** Orivon lets a page have 16 calls of a standard in flight and a bucket of 64 calls that gains 8 a
second, and refuses the rest as `limit`. Every read through `orivonChain` waits in one queue per page (`callQueue`):
8 in flight, a bucket of 48 that gains 7 a second, and a call refused as `limit` goes back to the front while the queue
waits, doubling from 250 ms, up to 5 times. A card of My IDs makes dozens of reads, so My IDs draws every card at once
and reads them in turn, and a page of IDs fills in at about 7 reads a second after the first 48.

**A name's records are asked together.** `recordsAt` (and `records`, which reads the registry's resolver and then calls it) asks for
the address, the contenthash and every text key in one call, which is one read in the queue: after one `supportsInterface`
question, a single `resolve(name, multicall(calls))` on a resolver that declares ENSIP-10 (the PermissionedResolver answers each
call's revert in its own item), or the resolver's `multicall(calls)` itself when it does not. A resolver with no `multicall`, or
one whose `multicall` stops at a single revert, is asked through Multicall3's `aggregate3` with each call allowed to fail
(`0xcA11bde05977b3631167028862bE2a173976CA11`; an address with no code answers nothing and the next way is tried), and
otherwise one call per record. Each way is tried only when the one before it failed as a whole. A record the resolver fails is
listed in `failed` and the others are still read; a node that cannot be asked rejects the read, as every read does. A card of
My IDs reads its records in 3 calls (the registry's resolver, the question, the batch) whatever the number of keys, and the `.orv`
resolver asks its records in one multicall of its own (`site/resolver/orv-records.js`).

**Resume trusts only what it cannot derive.** The stored label, price and commitment are derived again, and so is
the plan of transactions (`decide` reads it from the chain, never from the record): the
label must be one the registrar sells and not a reserved one, the price must be `price(label)`, the
commitment must be the registrar's hash of the record's label, owner, resolver and secret, the owner must be
the account asked for, and the resolver the one the factory predicts for it. The approval is always for
`price(label)`. A record that disagrees is deleted and `resume()` answers `failed` with the reason
`recordDiscarded` and the `mismatch`.

Tests: `register-tx` against `cast calldata` vectors, the state machine over a fake chain and clock
(each transition and each resume path), the relay over a fake transport, `register-privacy` (what the node
is asked, by name, and the decoys), `register-nonce`, `register-resume-trust`, and fork tests of the whole
flow on `anvil` (a contract-wallet owner that refuses ERC-1155 stops at the check; an account with a
resolver already at the fixed salt reuses it) and of the private reveal's gas limit (`fork-register-gas`).

## Moving an ID to your own resolver

An ID can pass ownership and still point at a resolver its holder cannot write: the previous holder's, or the
giver's after a gift. Sign-in refuses it as `recordsNotHeld`. When the address holds the ID alone (the owner and
roles clauses pass, and the holder has the registry's set-resolver role) `#/me` offers **Move to your own
resolver** in place of **Edit records**, as three transactions the wallet confirms one by one, listed the way the
registration lists its steps:

1. Create the holder's resolver, the PermissionedResolver at `predictProxyAddress(holder, SALT)`, with the
   registration's own `deployResolverTx`. It is skipped when that address has the factory's contract.
2. On that resolver, set the ID's address record to the holder; and, when "Copy the current records" is ticked
   (it is, by default), the contenthash and the text records the page lists, read from the old resolver. A record the
   old resolver would not answer is left out and said so; the record that ends sign-ins is never copied.
3. `setResolver(labelId, resolver)` on the registry.

Before anything is sent the panel says that moving ends every sign-in made with the ID (a sign-in names the
resolver it was made on, `resolverChanged`) and that the old resolver keeps its copy of the records. After step 3
the page reads the ID again and shows **Can sign in** only when `attribution` passes.

**The chain is the only state.** `planMove` is a pure function of what `observeMove` read: whether the resolver
has code, whether the new resolver holds the address and the chosen copy, and which resolver the registry names.
A step is done when the chain shows it, so a page that reloads halfway runs the same reads and goes on from the
first step not done; nothing about the move is stored. `moveOffer` refuses a name the address does not hold alone,
or whose roles could not be read, and `resolverBlocked` stops when a contract that is not the factory's sits at
the holder's resolver address.

**The send path is the registration's.** Each step is estimated with the margin the public reveal uses, signed
and sent through the broadcaster `app.js` builds (`nonceAfter` and `noteBroadcast` apply), one send of an account
at a time, and waited for; the next read starts at the block of the last receipt. `recordsAt` in `sdk/orivonid.js`
reads the records a given resolver answers, which is how the new resolver is read before the registry names it.

Tests: `move-model` (each state, the copy choice, resume from each step, the words), `move-flow` over a fake chain
(every phase, a declined or reverted step, a reload between steps), and `fork-move` on `anvil` (a gifted name moved
for real, a sign-in made before the move failing `resolverChanged`, sign-in and verify after it, resume, and the
refusal when another account holds a role).

## Design notes

**One Chain, three ways to reach it.** The page speaks only to the `Chain` interface. Inside Orivon
it is `orivonChain`, outside it is `eip1193Chain`. A JSON-RPC URL adapter exists only in the tests
(`test/support/rpc-provider.ts`), because the page has no URL to ask and no host to ask it at.

**Errors are a small set of reasons.** Every failure is a `ChainError` with one of `noWallet`,
`declined`, `unavailable`, `timeout`, `limit`, `invalid`, `reverted`, `unknownOutcome` and
`badAnswer`. `unknownOutcome` carries the transaction hash: a broadcast that timed out may have gone
out, and the page must say so instead of asking the person to try again.

**A name signs you in only when four things agree** (`attribution`): the label's owner on the
ENSv2 registry is the address; the address holds every role on it (a role read that fails is
`rolesUnreadable`, never zero); the label, resolved forward through its own resolver, gives that
address; and the address can write the name's records on that resolver (the factory vouches for it as
the PermissionedResolver, and the address holds the text and address roles, so it can end its own
sign-ins). A reserved label that has no resolver fails the third, on purpose.

**Untrusted answers are decoded strictly.** `abi.js` refuses an offset or length that points outside
the data, a bool that is not 0 or 1, an address with dirty high bytes, and a string that is not
UTF-8, so a hostile node or resolver can fail a read but not shape one.

**Names are found by their transfers.** `namesOf` scans the registry's ERC-1155 transfer and
registration logs in 1024-block chunks (the most the Orivon API answers) from the registry's first
block, keeps a cache the page may store, and re-scans the last 16 blocks each time so a reorganised
block never leaves a name in the list.

## Sign-in for other Web3sites

[`site/PROTOCOL.md`](site/PROTOCOL.md) is the spec, served as a file of the page. A site that wants "sign in with an Orivon ID" copies `site/sdk/`
whole into its own bundle (no CDN, so its Web3 Score stays at Level 4) and declares
`"capabilities": { "id": { "curves": ["P-256"] } }` in its manifest when it wants the delegated key.

| File | What it is |
|---|---|
| [`site/sdk/siwe.js`](site/sdk/siwe.js) | Pure: EIP-4361 build and strict read (anything that does not write back byte for byte is refused), the EIP-191 hash, RFC 3339 and RFC 3986 leaves |
| [`site/sdk/protocol.js`](site/sdk/protocol.js) | Pure: the request and its bounds, the one message and its statement, the response codec. Both sides build from it |
| [`site/sdk/p256.js`](site/sdk/p256.js) | The key `orivon.id` serves: compress and open a P-256 point, check a signature with WebCrypto |
| [`site/sdk/key.js`](site/sdk/key.js) | `appKey(orivon, { origin })`: the origin's key, compressed, and `sign(payload)` in the form `verifyAction` checks (the audience in the frame, s in the lower half) |
| [`site/sdk/permissions.js`](site/sdk/permissions.js) | Whether an account can write a name's records on its resolver (`recordsHeld`), and the role constants of the PermissionedResolver |
| [`site/sdk/verify.js`](site/sdk/verify.js) | `verifySignIn` and `verifyAction`: every check, in order, each failure named |
| [`site/sdk/connect.js`](site/sdk/connect.js) | The relying site's calls: `requestSignIn`, `readResponse`, `completeSignIn`, `revokeAllCall`, and the two verifiers |
| [`site/connect-request.js`](site/connect-request.js) | The ID site's side, no DOM: read a request, check how the person arrived (`checkArrival`), build and sign the message, build the URL back, and the words for what stops a username from being offered |

```js
import { appKey, requestSignIn, readResponse, completeSignIn, verifyAction } from './sdk/connect.js'

const key = await appKey(orivon, { origin: location.origin })              // optional: only to delegate
location.assign(requestSignIn({ returnUrl: location.origin + '/signed-in', delegateKey: key.publicKey, ttl: 2_592_000 }))

// on /signed-in:
const answer = readResponse(location)                                      // null when the URL holds no answer
if (answer?.kind === 'response') {
  const result = await completeSignIn(answer.response, { chain, now: Math.floor(Date.now() / 1000) })
  if (result.ok) { /* result.address, result.names, result.key, result.notAfter */ }
}

// later, for each request the key signed:
await verifyAction({ signIn: storedResponse, payload, signature: await key.sign(payload), origin: location.origin, chain, now })
```

**The relying site's key is P-256.** `orivon.id` derives one key per origin from the person's seed
(`src/broker/policy/derive-p256.ts` in Orivon). `publicKey({ curve: 'P-256' })` answers 65 uncompressed bytes and
`sign({ curve: 'P-256', payload })` 64 bytes, r then s, ECDSA over SHA-256 of the payload as given.
`secp256k1` fails `internal` there, so the delegated key cannot be one; and a P-256 signature has no
`ecrecover`, so `verifyAction` checks it with WebCrypto, which needs no code in `site/sdk/`. The SDK
signs `"orivonid:action:v1\n"`, the audience origin and a line feed before the payload, so a signature made for
another purpose or another site with the same key never reads as a request, and keeps s in the lower half of the order, since
`verifyAction` refuses the other form.

**The person's signature is checked on chain.** `ecrecover` is an `eth_call` to precompile `0x01`
through the person's own node, so a page needs no signature library either; EIP-1271 is asked only
when `ecrecover` names another address and the address has code. `test/support/secp256k1.ts` holds
the only secp256k1 arithmetic, to sign as a person would; `test/wallet-vector.test.ts` checks it against
the Orivon wallet's published signature for `Hello World`, byte for byte.

The fork tests (`test/fork-signin.test.ts`) buy a name for an account whose key the test holds, sign in
through the real `ecrecover`, registry and resolver, delegate a key, sign an action, revoke, transfer
the name, and sign in from an account that delegates by EIP-7702.

## The `.orv` resolver

`site/resolver/` is a name resolver the site carries, declared in [`orivon.json`](orivon.json) as the integration
`orv-names`, shown as "ID names (.orv)": Orivon draws an installed integration's own icon only when its name holds no
word that a built-in service goes by. It answers Orivon's `NAMES_0_1` for the names under `.orv`, so `alice.orv` opens what `alice.v1.orivonid.eth`
holds. It is a page that runs hidden inside Orivon, not a server, and it reads Ethereum through `ETH_NET_0_1_READONLY`
and nothing else: a resolver provides `NAMES_0_1` and may not use it.

| File | What it is |
|---|---|
| [`site/resolver/index.html`](site/resolver/index.html) | The hidden page: one module script, nothing inline |
| [`site/resolver/resolver.js`](site/resolver/resolver.js) | `provide('NAMES_0_1', { resolve })`, once; reads Ethereum with the `use` of the call it serves |
| [`site/resolver/orv-names.js`](site/resolver/orv-names.js) | The name rules, the check that the owner alone controls the label, and the walk from the registry to the resolver |
| [`site/resolver/orv-records.js`](site/resolver/orv-records.js) | The resolver's contenthash and content text records, in one multicall or one by one |
| [`site/resolver/orv-answer.js`](site/resolver/orv-answer.js), [`orv-contenthash.js`](site/resolver/orv-contenthash.js) | The records as the answer `NAMES_0_1` defines: ENSIP-7 contenthash to an address, text values to addresses |
| [`site/resolver/orv-names.svg`](site/resolver/orv-names.svg) | The integration's icon |

**How a person adds it.** In Orivon, open this site and press the key in the address bar: the Uses page lists the resolver
under "Brings its own", with an "Add to browser" button. Or open Integrations, "Add from a site...", and type
`id.orivonstack.eth`. Either asks one question that names what is added, the standard it uses and the site it comes from;
nothing is written before the yes. The declaration also allows the site's own copy (`onTheFly`), which runs for this
site alone while one of its pages is open and needs no add.

**When `.orv` starts to open.** Orivon routes a namespace it has not seen before from its next start, because it hands the
network layer the namespaces of the installed resolvers once, at launch. After the add, Orivon asks to restart; `alice.orv`
opens from that start. The site's own copy is never routed, so it cannot open a name typed in the address bar. This is how
the Orivon build this page was written against behaves; a build that routes a namespace as it is added needs no restart.

**How `.orv` relates to `<label>.v1.orivonid.eth`.** `.orv` is not a DNS name: it exists only in Orivon, which sends it to
this resolver. `<label>.orv` stands for `<label>.v1.orivonid.eth` and `<a>.<label>.orv` for `<a>.<label>.v1.orivonid.eth`,
the same labels in the same registry (R1), with the same owner, resolver and records. Nothing about `.orv` is stored
on chain; the resolver builds the Ethereum name from the labels it has checked.

| Step | What the resolver does |
|---|---|
| Name | Only `<label>.orv` and deeper names, in any case, with one trailing dot allowed. The label that was sold must pass `isValidLabel` and be ASCII; a label below it is 1 to 63 of `a-z`, `0-9` and inner hyphens. At most six labels. Anything else is "not found" and no chain call is made; a name outside `.orv` is refused so the router asks the next provider |
| Owner | `R1.getOwner(id)` names a holder, and `R1.roleCount(id)` equals `R1.roles(id, holder)`: the holder alone controls the name. A name someone else holds a role on, a name nobody holds and a reserved label answer "not found", and no resolver is asked |
| Resolver | `R1.getResolver(label)`; for a deeper name, the walk down `getSubregistry` of each label and the deepest resolver found, as ENSv2 finds it. No Universal Resolver is asked. A resolver above the end of the name counts only if it is ENSIP-10 |
| Block | Every read is made at the block `blockNumber` answered first, and the answer says which |
| Records | Asked of the resolver for `<...>.v1.orivonid.eth`, on chain only (an off-chain lookup is not followed) |

| The resolver's record | The answer |
|---|---|
| `contenthash` (ENSIP-7: ipfs, ipns key or DNSLink, swarm, arweave) | `ownerDefault`: type `ipfs`, `ipns`, `bzz` or `arw`, value `ipfs://<CIDv1>`, `ipns://<key or domain>`, `bzz://<reference>` or `ar://<id>`; `null` for none or a protocol Orivon does not load |
| text `content.ipfs`, `content.bzz`, `content.arw`, `content.magnet`, `content.https`, `content.http`, `content.ddoc` | `records`, in that order, one per key, type `ipfs`, `bzz`, `arw`, `magnet`, `https`, `http`, `ddoc`; a value that is not well-formed, or is over 2048 characters, is left out |
| text `url`, `addr`, any other key | not part of the answer |

A name whose records are all empty answers no default and no records, which Orivon reads as "Nothing here". The resolver
throws only when the node cannot be asked, or when it could read no record because some failed to answer, so the router goes
on to the next provider. A text value is passed as its owner wrote it, in the form of an address; Orivon reads each
record again before it loads anything from it.

Tests: the name rules, the owner check, the walk and the failures over a fake registry (`test/orv-names.test.ts`); the
contenthash vectors, which agree with `multiformats` byte for byte, and the text rules (`test/orv-answer.test.ts`); the
manifest entry, the page, the icon, and `provide` called once with exactly `resolve` (`test/orv-integration.test.ts`); and a
fork test that buys a name for real, sets its records and resolves it end to end, including a role granted to a second
account and taken back (`test/fork-orv.test.ts`).

## The interface

`site/index.html` holds one module script, `main.js`, and nothing inline, so the page runs under a
content security policy with no `unsafe-inline`. `style.css` is the one stylesheet: a system font stack, one
accent, light and dark by `prefers-color-scheme`, readable from 360 px. No file is fetched from another
origin; the one network host is the private send's, and only when the person turns it on.

**The reading strip says what the page has.** `watchReads` wraps the Orivon chain's reads and notes whether Orivon let
one through or answered that the person did not allow it (`session.reading`: `unknown` until a read has answered, `allowed`,
`refused`). `stripOf` turns that and the kind of chain into the strip: only Orivon with the read allowed wears the
shield and says the light client answers; a refused read says so and how to be asked again (close every tab of the
site and open it again); a wallet extension says it reads through its own server; no wallet says so. A sales read that
fails shows as unknown, with a button to ask again unless Orivon refused it.

Each view is a pure model (state in, plain data out, unit-tested) and a thin module that draws it and
dispatches to the registration flow. Elements are built with `el()`: text and attributes only, never
markup from a string, which `test/static.test.ts` enforces.

| File | What it is |
|---|---|
| [`site/main.js`](site/main.js), [`router.js`](site/router.js) | Starts the page, the hash router (`#/`, `#/me`, `#/connect`, `#/developers`), the banner for a registration under way |
| [`site/app.js`](site/app.js) | One per page: the chain, the stored names, the relay, the registration state with its timing and hashes, the connected address |
| [`site/header.js`](site/header.js), [`header-model.js`](site/header-model.js), [`parts.js`](site/parts.js), [`dom.js`](site/dom.js), [`icons.js`](site/icons.js), [`words.js`](site/words.js) | The header and the always-visible address and reading strip, shared widgets (the Web2 mark among them), DOM helpers, inline SVG icons, the words and number spellings |
| [`site/search-model.js`](site/search-model.js), [`view-search.js`](site/view-search.js) | `#/`: the format check and the price as the person types, which ask no node; availability and the receiver check when the person presses the button (`askAboutName`), with `SEARCH_WORDS` beside the box |
| [`site/register-model.js`](site/register-model.js), [`view-register.js`](site/view-register.js) | The registration panel for every `phase` of `register-flow.js`, with the countdown from block time; its buttons sit in a bar that sticks to the foot of the window while any of the panel is in view, and the form keeps only the name and the verdict while the panel offers to register |
| [`site/me-model.js`](site/me-model.js), [`view-me.js`](site/view-me.js), [`view-me-card.js`](site/view-me-card.js) | `#/me`: the IDs of the connected address, their records, edit (offered when the address can write the records, and the move to its own resolver in its place when it cannot), and end all sign-ins, which is offered only where `revokeAllCall` says the holder can write the resolver (`endAvailability`) |
| [`site/offer-model.js`](site/offer-model.js) | Why an ID the address holds cannot sign anyone in, and what a person can do about it (`moveOffer` says whether the move is open to it), for `#/connect` and `#/me` |
| [`site/move-model.js`](site/move-model.js), [`move-reads.js`](site/move-reads.js), [`move-flow.js`](site/move-flow.js), [`view-me-move.js`](site/view-me-move.js) | The move to the holder's own resolver, in a card of `#/me`: the plan the chain implies, the reads, the state machine and the panel (section Moving an ID to your own resolver) |
| [`site/connect-model.js`](site/connect-model.js), [`view-connect.js`](site/view-connect.js) | `#/connect`: `connectEntry` decides between the consent screen, a stop screen and the invalid-request screen; the view passes it the hash, `document.referrer` and whether the page is framed |
| [`site/developers-model.js`](site/developers-model.js), [`view-developers.js`](site/view-developers.js) | `#/developers`: how a site copies `sdk/`, the rules it must keep (`PROTOCOL.md` section 9) and the words for each refusal |

Before it shows a request, `#/connect` asks `checkArrival` whether the person came from the site the request names. A
page inside a frame, or one reached from another site, gets a stop screen with the reason and no sign-in button; a plain
sign-in reached with no referrer gets a warning above the consent. Cancel, and the invalid-request screen, go back to the
site only through `exitTarget`, and when it answers nothing they send nobody anywhere.

The consent screen shows the requesting origin as its largest element, then the whole return address beside it when the
request names more than the origin. IDs are ticked by default and can be unticked; the IDs the address holds but cannot sign
in with are listed apart, each with why and what to do. With a delegated key it shows how long the site may act, what that
allows and that it never allows moving funds. The page never asks for `setApprovalForAll`, and it says what is permanent
before it asks for a signature that is. Sign in and Cancel sit in a bar that sticks to the foot of the window, and the bar's first
line says that the wallet will warn and why, so the words are in view whenever the button is.

**Looking at it without Orivon.** `test/support/browser-orivon.ts` is a fake `orivon` for a browser page:
an in-memory registry and market, a wallet that signs through services the test driver injects, and a
clock the test advances. It lives under `test/`, never `site/`.

**Looking at the screens.** `node apps/id/test/shoot.mjs [--out <folder>] [scene...]` serves `site/` over HTTP with that
fake and takes a headless Chromium screenshot of each scene (the connect, My IDs, registration and search screens) at 360
and 1280 px (1280 by 800), light and dark, into `out/id-shots` or the folder given, and prints a JSON list of what a scene found wrong;
`QUICK=1` shoots 360 px light only. A scene with `fold` also leaves the window as the person sees it before scrolling, and
`register-ready` fails when the Register button is below it. It takes esbuild and playwright from this checkout's `node_modules`, and from the
`node_modules` of the folder in `MODULES` when they are not installed there.

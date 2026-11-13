# `apps/og/`: OG names, Linagee's `.og` names opened in Orivon

## About this page

**OG names is a name resolver for `.og`, the names of the Linagee Name Registrar on Ethereum: `alice.og` opens the site that the name's holder pointed it at. It is written by Orivon in this repository and is not a port.**

| | |
|---|---|
| Version | 0.1.0 |
| Source | This directory: [`recipe.json`](recipe.json), [`orivon.json`](orivon.json), [`site/`](site/) |
| Licence | This repository's, [AGPL-3.0-only](../../LICENSE); the vendored name normalizer is MIT (section Licences) |
| In another browser | Nothing opens: `.og` is not a DNS name, and the resolver is a page that only Orivon runs and asks. |
| Updates | Written in this repository, so a change here is the update; there is no schedule. The census (section The census) is cut again for each release. |
| Problems | [Report a problem with this page](https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=OG%20names): it goes to this repository's issue form. |

The sections below are for people working on the page.

**What lives here.** A name resolver, declared in [`orivon.json`](orivon.json) as the integration `og-names` and shown as "OG names (.og)", the tool that cuts the history it carries, and the site that finds, registers and manages a name (sections The registration page and Your names). It answers Orivon's `NAMES_0_1` and `NAMES_0_2` for the names under `.og`. It is a page that runs hidden inside Orivon, not a server, and it reads Ethereum through `ETH_NET_0_1_READONLY`, the person's own light client. Only `setRecord` asks for more: `ETH_0_1` (the address and the signature) and `ETH_NET_0_1` (the broadcast), both optional, and the person confirms the transaction in their wallet. The site, not the resolver, holds one more grant, `trust.score`: it lets the browser draw its own mark where the site puts an `<orivon-mark>`, which is only beside the private-send switch (section The registration page). The page asks no score itself. The manifest has no field in which to give a reason for a capability, so the reason is here. The site is a `site` recipe, served as `og.orivonstack.eth` in development; it is plain JavaScript with no build step.

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json), [`orivon.json`](orivon.json) | A `site` recipe, and the manifest with the one integration |
| [`site/index.html`](site/index.html), [`main.js`](site/main.js), [`router.js`](site/router.js), [`app.js`](site/app.js) | The site's page, its one module script, the routes (`#/`, `#/name/<label>`, `#/names`, `#/names/<label>`) and the object that holds the chain, the session, the store and the series that is running |
| [`site/search-model.js`](site/search-model.js), [`view-search.js`](site/view-search.js), [`words.js`](site/words.js) | The search: the four states of a name and its records as plain data, the view that draws them, the words they use |
| [`site/register-plan.js`](site/register-plan.js), [`register-tx.js`](site/register-tx.js), [`register-reads.js`](site/register-reads.js) | The series of a registration as data (steps, gas), the calldata of each step, and the reads that guard it |
| [`site/register-flow.js`](site/register-flow.js), [`register-send.js`](site/register-send.js), [`register-tip.js`](site/register-tip.js) | The flow that sends one step at a time and checks between them, the senders over `orivon` or a wallet extension, and the tip |
| [`site/register-model.js`](site/register-model.js), [`register-words.js`](site/register-words.js), [`view-register.js`](site/view-register.js) | The form's choices and cost as data, the words of each outcome, and the panel |
| [`site/series-run.js`](site/series-run.js) | The loop both series run on: sign, then send one step at a time with a rule before it and a check after its receipt, and the kinds of stop |
| [`site/manage-plan.js`](site/manage-plan.js), [`manage-flow.js`](site/manage-flow.js), [`manage-words.js`](site/manage-words.js) | A change to a name the person holds: the plan of each action from what the chain shows, the flow that sends it on the loop above with a rule and a check for each kind of step, and the words of each action and outcome |
| [`site/manage-model.js`](site/manage-model.js), [`manage-forms.js`](site/manage-forms.js), [`view-manage.js`](site/view-manage.js) | The actions a name offers and the request a form describes, as data; the panel of each action; the page of one name |
| [`site/names-model.js`](site/names-model.js), [`names-reads.js`](site/names-reads.js), [`store.js`](site/store.js), [`view-names.js`](site/view-names.js), [`view-records.js`](site/view-records.js) | The list of the account's names: a row's state, chips and controller as data, the reads that find the names, what this device remembers, the view, and the records list the search shares |
| [`site/art-model.js`](site/art-model.js), [`art.js`](site/art.js) | The card of a name, drawn locally as an SVG: the lines a label breaks into, the colours its bytes pick, and the node |
| [`site/badge-model.js`](site/badge-model.js), [`badge-reads.js`](site/badge-reads.js), [`view-badge.js`](site/view-badge.js) | The Orivon ID badge: what the ID's `attribution` says as data, the check through the ID SDK, and the card |
| [`site/header.js`](site/header.js), [`header-model.js`](site/header-model.js), [`dom.js`](site/dom.js), [`parts.js`](site/parts.js), [`relay.js`](site/relay.js), [`icons.js`](site/icons.js), [`style.css`](site/style.css) | The shell: the bar and the connect button, small DOM helpers, the private-send relay, the icons and the stylesheet, which has one theme, a dark one, for every system setting |
| [`site/assets/`](site/assets/) | The site's own fonts, with a licence note, and pictures: pixel clouds, the moon, the voxel meadow and a chevron. Nothing is loaded from elsewhere |
| [`site/resolver/index.html`](site/resolver/index.html), [`resolver.js`](site/resolver/resolver.js) | The hidden page, and the module that provides `NAMES_0_1` and `NAMES_0_2` with the `use` of the call it serves, keeps one session, one call queue and the census for the page's life, and reads ahead when it starts |
| [`site/resolver/og-names.js`](site/resolver/og-names.js) | `resolveOg`: one name, from the name rules to the answer; `warmUp` |
| [`site/resolver/og-name.js`](site/resolver/og-name.js) | The name rules and the registry key of a label |
| [`site/resolver/og-state.js`](site/resolver/og-state.js) | The block a lookup is pinned to, and the state of a name at it in one `aggregate3` |
| [`site/resolver/og-freshness.js`](site/resolver/og-freshness.js) | Who holds a name, and which of its keys count (section Which records count) |
| [`site/resolver/og-census.js`](site/resolver/og-census.js) | The census as the resolver reads it, and the logs an entry stands for |
| [`site/resolver/og-tail.js`](site/resolver/og-tail.js) | Log scans in windows of 1024 blocks, kept for the page's life, inside the time a call has |
| [`site/resolver/og-guard.js`](site/resolver/og-guard.js) | The check on the resolver contract's implementation |
| [`site/resolver/og-answer.js`](site/resolver/og-answer.js) | The records as the answer `NAMES_0_1` defines |
| [`site/resolver/og-set-record.js`](site/resolver/og-set-record.js) | `setRecord` |
| [`site/resolver/og-pins.js`](site/resolver/og-pins.js) | The three contracts, the pinned implementation, the event topics and the keys read |
| [`site/resolver/census.json`](site/resolver/census.json) | The census |
| [`site/resolver/vendor/`](site/resolver/vendor/) | `@adraffy/ens-normalize` 1.11.1 and its licence |
| [`site/resolver/og-names.svg`](site/resolver/og-names.svg) | The integration's icon |
| [`site/sdk/`](site/sdk/) | Copied from `apps/id/site/sdk/`, each app standing alone: `abi.js`, `bytes.js`, `keccak.js`, `chain.js`, `chain-orivon.js` (with `getStorageAt`, and a queue a page can share between the chains it makes per call), `chain-eip1193.js`, `chain-detect.js`, `ens.js` and `read.js` (one `aggregate3` of Multicall3 per batch); `orivonid.js`, `permissions.js` and `scan.js` are the ID SDK's own, for the badge |
| [`tools/cut-census.mjs`](tools/cut-census.mjs), [`rpc-chain.mjs`](tools/rpc-chain.mjs) | The census tool, and the Chain over two nodes that must agree |
| [`tools/fork-series.mjs`](tools/fork-series.mjs), [`fork-world.mjs`](tools/fork-world.mjs), [`fork-cases-register.mjs`](tools/fork-cases-register.mjs), [`fork-cases-manage.mjs`](tools/fork-cases-manage.mjs), [`fork-handles.mjs`](tools/fork-handles.mjs), [`fork-signer.mjs`](tools/fork-signer.mjs) | The registration and the changes to a name against an anvil fork of mainnet (section Running the tests): the driver, the fork's shared helpers, the two lists of cases, a stand-in for the page's `orivon` over JSON-RPC, and a signer of real type-2 transactions |
| [`tools/shoot.mjs`](tools/shoot.mjs), [`shoot-scenes-manage.mjs`](tools/shoot-scenes-manage.mjs), [`shoot-contrast.mjs`](tools/shoot-contrast.mjs) | Headless screenshots of the site's states, and the check that no view throws or reaches another origin, that a light system gets the same page, and that every word has WCAG AA contrast; the second file holds the scenes of the account's names and of a name's page |
| [`test/`](test/) | Unit tests over a fake chain and a simulated Linagee (`test/support/linagee-world.ts`). Never served |

## Running the tests

```bash
npx vitest run apps/og        # unit tests; no network
node apps/og/tools/fork-series.mjs   # the registration and the changes to a name against a mainnet fork; needs anvil and a node to fork from
node apps/og/tools/shoot.mjs         # the site's states in a headless browser, as screenshots in out/og-shots
```

The tests replay twenty names (nine live on mainnet, eleven played on a fork of it) through a fake chain, once with all of the history read from the node and once with all of it in the census, and both must give the answer the rule gives. The rest cover the guard, the census cases, the call's time, the block every read is pinned to, `setRecord`, the page, the vectors an install runs against the page for `NAMES_0_1` and `NAMES_0_2`, and the census tool, which runs against the fake chain and never against a node. The registration and the changes to a name are tested twice: against a table that executes the three contracts' own rules (`test/support/linagee-world.ts`, including the calls that do nothing without saying so, and enough of the Orivon ID contracts for the badge), and by `fork-series.mjs`.

`fork-series.mjs` starts `anvil` forked from a public node (`ORIVON_OG_FORK_RPC` first), funds a throwaway key, and drives the page's real send code through `forkOrivon`, which answers each handle by JSON-RPC and keeps the shape rules of Orivon's broker. Every transaction goes to the fork, never to mainnet. It runs wrapped with one confirmation, unwrapped, wrapped with a wallet that signs one by one, a name taken in the middle, wrapping switched off before and during the series, no tip, a tip to a contract (signed with the gas the node estimates, a quarter more), and Continue after a stop at the tip (the tip is paid once); after each run the resolver's own `resolveOg` must answer the new name's record with every freshness rule passing. The changes to a name run as the page's own manage flow plans and sends them: fixing the controller of an unwrapped name and of a wrapped one (unwrap, `setController`, `createWrapper`, `transfer`, `wrap`, the token number changing), giving a name away unwrapped (primary name and controller ended first, so the receiver's own write counts at once and the seller's site does not count for the receiver), giving a wrapped one away as a token (the records wait until the receiver fixes the controller), cleaning up and then giving away, clearing records, setting a primary name that replaces the last, and wrapping and unwrapping with the site written again. After each, `resolveOg` and the reason of every key must say what the page said would happen. `shoot.mjs` needs `esbuild` and `playwright-core` (it reads `MODULES`, a node_modules folder, first) and draws every state, the account's names and each kind of name's page among them (a name in a spelling Orivon does not open too), at 360 and 1280 px; it fails on sideways scrolling, an error in the console, a request to another origin, a page that looks different when the system asks for light, text under WCAG AA contrast (as a person sees it: faded text, a placeholder and SVG text are counted by what shows), and a control's edge or focus ring under 3 to 1 (the search and name fields, the radio cards and their dots, the switches in both positions and the main buttons; `CONTRAST_REPORT=1` prints every figure).

## How a name is answered

`alice.og` is the Linagee registry key `alice`: the label's UTF-8 bytes, padded with zeros to 32. The registry accepts any bytes, so the resolver answers only a label that [ENSIP-15](https://docs.ens.domains/ensip/15) leaves as it is (`Alice.og` is not `alice.og`), of at most 32 bytes, with no dot before `.og`. Anything else is "not found" with no chain call; a name outside `.og` is refused as `invalid`, so the router asks the next provider.

| Step | What the resolver does |
|---|---|
| Block | One block, `B`, for every read of a lookup: the node's safe block, or its latest when the node names none or this page has just written the name, and never before the census checkpoint |
| Holder | `owner(key)` on the registry; when the owner is the wrapper, the holder of the wrapper's token (`nameToId`, `idToName`, `ownerOf`). A name the wrapper holds with no token for it has no holder but the wrapper |
| Records | `getTextRecord` on the resolver contract for each key in the table below, with `controller(key)`; all of it in one `aggregate3` of Multicall3 at `B`, each call allowed to fail on its own |
| Guard | The resolver contract's implementation slot holds the implementation this bundle was built against, the census lists exactly the upgrades the contract had, and no `Upgraded` log of the contract exists after the census checkpoint (section Which records count) |
| History | The logs of the name from the census checkpoint to `B`, read from the node by name (section The time a call has) |
| Answer | The keys that count, in the order below, as addresses; no owner default |

| Text key | Answer |
|---|---|
| `content.ipfs` | `ipfs` (`ipfs://<id>`, or `ipns://<key>` for an IPNS value) |
| `content.bzz`, `content.arw`, `content.magnet`, `content.ethfs`, `content.https`, `content.http`, `content.ddoc` | `bzz`, `arw`, `magnet`, `ethfs`, `https`, `http`, `ddoc` |
| `contentcontract`, any other key | not part of the answer |

A value that is not well-formed for its type, or is over 2048 characters, is left out; a value is passed as its holder wrote it, in the form of an address, and Orivon reads each record again before it loads anything from it. A name that is not there, has no record or has none that count answers no records, which Orivon reads as "Nothing here". The resolver throws only when the node cannot be asked, so the router goes on to the next provider, or refuses in words (section The time a call has).

**No owner default.** Linagee has no record that marks one. Orivon takes a reply with a null `ownerDefault` and records as it takes any other: `recordsOfReply` in `src/protocols/verifier-host/integration-resolver.ts` adds no owner record for a null default and keeps the rest in the order given, and a name with at least one record opens from them. The answer lists the keys in the order of the table above for that reason.

## Which records count

The holder is the registry's word, and the registry is immutable. The records are the resolver contract's, and the contract is an upgradeable proxy that a Safe of nine owners (five to act) can point at any code in one transaction, with no delay. A record is only as good as the code behind it, and the contract keeps a record after the name changed hands. So a key counts only when all of these hold:

1. **The controller is zero or the holder.** The contract lets a name's controller write its records, and a controller the previous holder set can still do it.
2. **A `SetTextRecord` log carries the value now stored.** The log has the key and the value as hashes and names no writer; the resolver compares the hash of the value it read with the latest log for the key. A key with no such log is never answered: the value could have come from before the contract logged it.
3. **That log is after the last change of holder.** For an unwrapped name, the latest `Changed` log of the registry for the name (a transfer, a disown, and also `setContent` and `setAddress`, so those drop a record too, strictly). For a wrapped one, the latest wrapper `Transfer` of its token to the holder.
4. **That log is after the latest `NewController`** of the name, even one by the holder; writing the record again restores it.
5. **The implementation is the pinned one**, the census lists exactly the four upgrades the contract has had (`UPGRADES` in `og-pins.js`, the last at block 17,161,959 to the pinned implementation), and no `Upgraded` log of the contract exists after the census checkpoint. Pointing the proxy at other code and back leaves the slot as it was and an `Upgraded` log behind, so the slot and the log are both read; a round trip before the checkpoint would show in neither, so a census whose list is not the pinned one refuses every record. A guard that cannot be read, or whose scan does not finish, refuses the answer.

The rule is one function, `evaluateFreshness`, which the resolver and the census tool both run.

**What this does not cover, and says so.**

- The Safe can rewrite records in one transaction that leaves only an `Upgraded` event. That beats the guard only if the person's node also hides that event.
- A node's `getLogs` proves each log it returns is there, never that the list is complete. A node that hides a later change of holder or a later `NewController` makes a stale record count. A public node can drop a log that exists. The census narrows this to the logs between its checkpoint and `B`, and the person's own node is the one asked about them.
- The page keeps a window for as long as it lives, whichever call read it. The reads of a call that serves a site follow that site's route to the node, and the router never says which provider answered, so a window one provider gave can serve a lookup another would have answered. Every provider is one of the person's own, asked in the person's order, and each is held to the caveat above; the page cannot key its windows by provider, because it is never told which one it was.

Nothing here is a contract of Orivon's, and an answer says `proven: false`: Orivon shows it as what Linagee (.og) said.

## The census

Reading a name's history from the first block of the registry would take tens of thousands of log queries. The bundle carries the answer up to a checkpoint block instead, and the resolver reads the rest. `site/resolver/census.json` holds:

- the checkpoint, its block hash, and every `Upgraded` log of the resolver contract up to it: exactly the pinned four, the last at the pinned implementation;
- for each name that has a content value at the checkpoint (any key of `content.*` or `contentcontract`): the holder then and whether it held a token, the position of the latest change of holder and of controller, and for each key the hash of its value, the position of the log that wrote it, and the rule's verdict.

An entry stands for the logs it was cut from (`mergedLogs`). It stands for the change of holder only while the holder is the one it names, so a name that has moved since the checkpoint must show its own change of holder in the history after it, or its records fail closed. A name with no entry had no content value at the checkpoint: any record it has was written after it, and a change before the checkpoint is before that record.

```bash
node apps/og/tools/cut-census.mjs                 # cut at the finalized block both nodes share
node apps/og/tools/cut-census.mjs --block 12345   # cut at that block
node apps/og/tools/cut-census.mjs --check         # cut again at the file's own block and say whether it is the same file
```

The tool stops, and writes nothing, when the contract's `Upgraded` logs up to the block are not the pinned list (an upgrade to other code and back, an upgrade the pin does not know, or one the nodes left out), or when its implementation slot does not hold the pinned one. It reads from chain alone, through two nodes named by `OG_RPC_A` (default `https://rpc.mevblocker.io`) and `OG_RPC_B` (default `https://gateway.tenderly.co/public/mainnet`). Each answer is asked of both and compared; two that differ stop the cut, because a public node can drop a real log, and a count that came from one node proves nothing. Each node must answer `eth_getLogs` over a wide range for a rare topic, which many free plans refuse; the tool asks in ranges of 4 million blocks and halves a range a node refuses. State at a block older than a node keeps needs an archive node, so `--check` of an old census needs one. `census.json` is plain JSON in a fixed order, so a cut at the same block is the same bytes.

## The time a call has

A node answers a log query over at most 1024 blocks, so a stretch of chain is read as windows of 1024, each one node call. The history a lookup needs is two scans over the census checkpoint to `B`: one for the name (the registry's and the resolver contract's logs that carry its key, and for a wrapped name the wrapper's transfers of its token), and one for `Upgraded` logs of the contract, which is the same for every name. Orivon adds about 7,200 blocks a day, so a census a day old costs about seven windows a scan.

**The call's time.** Orivon gives a name-resolution call at most 30 seconds (`MAX_NAMES_CALL_MS` in `src/protocols/verifier-host/name-resolver-protocol.ts`, taken with the verifier host's own budget in `integration-resolver.ts`), and tells the page when it ends in the call's `deadlineAt`. This is how the Orivon build this page was written against behaves.

**The budget inside it.**

- The page has eight windows in flight at once, whichever scans and lookups want them, which is what the browser allows one page of the node (8 in flight, 7 a second, through one call queue the page shares). A scan waits for a turn before it lets a window go. A turn goes to a lookup before the page's own read-ahead, then to the call holding the fewest windows, then to the one that has waited longest, so one lookup with many windows left never keeps another waiting for all of them. A served call is told its depth and its deadline and nothing else, not who asked, so the page cannot tell the address bar from a site: each lookup is a call with a share of its own.
- A window is timed from the moment it is let go, never from the moment it was wanted. It is expected to take 3 seconds until some have been read, then one and a half times a running average that weighs the latest windows most, so a slow stretch is forgotten as quicker ones come.
- A scan lets a window go only if the time left, less 2 seconds the call keeps for itself, can take it, except that each call may let at least one round of windows go (the first window of each of a scan's eight workers) while it has any time left. A node that was slow for a while therefore never stops every later lookup: each one reads some more, and the windows are kept.
- A window already read, or being read for another lookup, is used as it is. The page keeps a window for as long as it lives, so the scan an earlier call began is what the next one continues, but only a window that ends at or below the safe block (or, for a node that names none, 64 blocks behind the latest): a lookup that reads the latest block reads blocks the node may still replace, and asks for those again. A window that failed is asked again.
- A scan never answers in part. When the time runs out it refuses in words, "Still checking ...: N of M stretches of the chain are left and the time ran out. What was checked is kept: try again shortly", which the loading screen shows and the page's console keeps, and the next lookup of any name resumes.
- A node that cannot be asked at all throws as it is, so the router asks the next provider; a node whose answer cannot be read refuses, since an answer that could not be read is not an answer that no upgrade happened.

**Reading ahead.** When the page starts, with the integration's own `use`, it reads the `Upgraded` scan and the history of the census names (at most 64), and stops starting reads after 50 seconds. No call waits for it, and it takes only the turns no lookup wants. An error stops that part and is logged.

## Setting a record

`NAMES_0_2.setRecord(name, 'contenthash', value)` points a name at an `ipfs://` or `ipns://` address (written under `content.ipfs`) or a `bzz://` address (under `content.bzz`), as the standard defines. The resolver contract lets the registry owner and the name's controller write, but this resolver answers a record only while the controller is the holder or there is none (section Which records count), so a write by anyone else would be paid for and never seen. The page reads the name at the latest block and answers `not-manager`, signing nothing, unless the account is the holder and the controller is none or the holder. A wrapped name's registry owner is the wrapper, so its holder writes only as the controller; for a holder who is not, the page says in words (the loading screen of a watched call, and the console) to unwrap the name, make the account its controller with `setController`, and wrap it again. For an unwrapped name whose controller is someone else, it names `unsetController` and `setController` as the way out.

The page sends `setTextRecord(bytes32,string,string)` to the resolver contract through the browser's wallet, which shows the transaction. A person who says no gets `declined`; a transaction mined and reverted, `failed`; one the contract refuses on estimate because the name moved, `not-manager`. After it is mined the page reads the record back, answers `seen` with the block and the value before, and the next lookup of the name pins to the latest block, so it answers the new record at once. Where the call has no time left to wait, or the read does not show the value, the answer is `sent`. `proven` is `false`: the page read the record through the person's node, with no proof of its own.

## The registration page

The page finds a name and registers it: type a label, and after a pause the name is read from Ethereum through the person's own node (in a wallet extension, through the RPC provider that extension uses, which sees the name). Four states come out of that read: free; held, by whom and wrapped or not; stranded in the wrapper with no token (the wrapper holds the name and is waiting for an account to finish wrapping it); and free again with a previous holder's records left on the resolver. Each record is listed with whether it counts and why in plain words, from the reasons `evaluateFreshness` gives, plus three the page adds: `left-behind`, `unverified` and `unopenable` (the label is not in the standard spelling, so Orivon never opens it, whatever the chain holds). A label the name rules refuse says which rule.

**The series.** A wrapped name is five transactions: `reserve`, `setController` (the wrapper will own the name in the registry, so only a controller named beforehand can write records later), `createWrapper`, `transfer` to the wrapper, and `wrap`. Records follow, then an optional tip. An unwrapped name is `reserve` and its records. The registry's `reserve` and `transfer` succeed and change nothing when the name is taken or the sender is not the owner, so the page never trusts a receipt alone:

- `owner(label)` is read before signing (it must be zero) and after `reserve` (it must be the account);
- `wrapEnabled` (byte 1 of the wrapper's storage slot 16, which its owner can switch off) is read before signing, before `createWrapper` and before `wrap`, and an unwrapped registration is offered when it is off;
- `transfer` is sent only after `createWrapper`'s receipt succeeded: a name transferred to the wrapper without it is stuck there;
- each step goes out only after the previous one was mined and succeeded; a step not sent is dropped, and the person is told what the stop cost;
- the tip goes last, and only when every step before it succeeded.

A stop leaves a state, not a lost run: the page reads the name again and offers what fits (continue, continue unwrapped, or finish wrapping when the connected account is the one the wrapper waits for). Finishing a wrapping sets records only when the account is also the name's controller. The request a stop continues carries what the earlier runs finished and where the tip stands: a record an earlier run wrote is not written again while the chain holds its value (the same value alone proves nothing, since a previous holder may have written it before the name changed hands), and the tip's transaction is read first. A tip that was mined is not sent again; one whose outcome is not known (a receipt not seen, a node that does not answer) is never planned again, and the page says so. A switched-off wrapper is the one residual the checks cannot remove: if wrapping is switched off after the name went to the wrapper, the name stays there, with no token for anyone, until the wrapper's owner switches it on again.

**Signing.** Where the wallet can sign a list (`ETH_0_1.signTransactions`) the whole series is one confirmation, and each transaction is then sent one at a time through `ETH_NET_0_1.sendRawTransaction`. A page cannot hold `signTransactions` today (the browser keeps it in a group a page is not given), so the site feature-detects it and falls back to one confirmation per step. A wallet extension has its own sender, one request per step, with no private send. A private relay that does not take a transaction stops the series with the relay's own words and offers to send publicly, with "Try the relay again" beside it.

**The tip.** "Support Orivon" is a ticked line with its amount shown and editable (0.0005 ETH, at most 0.005 ETH), a plain transfer of ETH to the address `orivonstack.eth` resolves to when the person presses Register. The standard that gives a page names has no address lookup, so the page asks ENS's Universal Resolver through the person's node; if that fails the tip is left out and the person told. The address is looked up again at Register, and a change since the review stops the series before anything is signed. At Register the page also reads the address's code: a plain address gets the 21,000 gas of a transfer; a contract gets the node's estimate and a quarter more, at most 100,000, and when it would not take the transfer, or needs more, the tip is left out and the series says why.

**Private send.** A public send lets anyone watching the network see the name before it is registered and take it. An optional switch sends through Flashbots Protect (a server sees each transaction and the IP address before it is public); public is the default. Beside the switch stand the plain word "Web2" and the browser's own `<orivon-mark of="https://rpc.flashbots.net">`, which the browser draws and the person's Web3 Score providers decide, and which needs the `trust.score` grant (a site without it gets the neutral mark, and the word still says what the relay is). A press on the mark opens the browser's card and does not flip the switch.

**When a name starts to open.** The resolver reads Ethereum at the node's safe block, so a site written just now opens from the address bar only once that block has passed the write: about 13 minutes on mainnet. The page says so after a registration that wrote a site and after a change to a name's records (`SAFE_WAIT` and `SAFE_REASON` in `site/words.js`); it says nothing after a change that writes no record.

**The foot of the panel.** The button that starts a registration ends the form, after the plan it starts, in the flow of the page: no bar stays at the foot of the window, so no choice or sentence is ever under one until the person scrolls. After a series has stopped, the buttons that continue or cancel come right under the notice that explains the stop, above the list of steps.

**Gas.** Measured on a mainnet fork, in gas used: `reserve` 45,149; `setController` 58,506; `createWrapper` 51,606; `transfer` 28,489; `wrap` 202,295; `setTextRecord` about 125,000 to 131,000; the tip 21,000. A wrapped registration with a site is about 530,000 gas, an unwrapped one about 197,000, and a `reserve` of a name already held, which does nothing, 23,749. The changes to a name used: `unwrap` 69,513; `unsetController` 36,264; `unsetTextRecord` 50,324; `setPrimary` 68,126 to 87,226 (the first is dearer than a replacement); `unsetPrimary` 34,556; the registry's `transfer` 28,525; the wrapper's `safeTransferFrom` 86,416 to 89,228; `setController` over an existing controller 41,442; `setTextRecord` with the value the record holds 45,922. Fixing the controller of a wrapped name is five transactions, about 393,500 gas.

## Your names

`#/names` lists the names the connected account holds, and `#/names/<label>` is the page of one. The list has three sources and says which one each row came from:

- **The wrapper's tokens.** `balanceOf`, `tokenOfOwnerByIndex` and `idToName` of the wrapper, read at one block, a page of 120 at a time; more than that are counted and said, not listed.
- **Names added here.** The chain keeps no list of the names a registry owner holds without a token. The person types one; the page checks on chain that the address holds it (or is the account a stranded wrapper waits for) and remembers it in this site's own storage, on this device only. A name that is no longer held is shown as lost and can be forgotten.
- **Hints.** The names the resolver's `primary(address)` and the registry's `name(address)` give for the address, each read on chain before it is shown.

Each row is read like the search reads a name: whether it is wrapped, whether each record counts and why not, whether the controller is the holder (a wrapped name whose controller is someone else keeps every record from counting), and whether a name is stranded in the wrapper, which the account can finish wrapping. A stranded name has no token, so it can be listed only when it was added or started here.

**A name in another spelling.** The registry and the wrapper hold any bytes, so an account can hold `Harbor`, which the name rules write `harbor` and Orivon never opens. Wherever its label comes from (a token, a hint, this device's list, the address of the page), the page marks it "Orivon cannot open this spelling", counts none of its records, and offers only to give it away and, when it is wrapped, to unwrap it.

**Actions.** The page of a name offers only what the account can do with it, each as a panel that names the contracts and functions it calls, lists the transactions with their gas and cost before anything is signed, and refuses with a reason and the action that would put it right. The page never offers a registry setter (`setContent`, `setAddress`): they are not part of what a site needs, and each one drops the records of the name.

| Action | What is sent |
|---|---|
| Set the site | `setTextRecord` for `content.*`, and optionally `contentcontract` |
| Clear, confirm again | `unsetTextRecord` (after `setController(self)` when another account is the controller), or `setTextRecord` with the value the record holds now |
| Make it the primary name | `setPrimary`, which replaces the account's previous primary name |
| Fix the controller | Unwrapped: `setController(self)`. Wrapped: `unwrap`, `setController`, `createWrapper`, `transfer` to the wrapper, `wrap`; the token number changes |
| Give it away | Unwrapped: `unsetPrimary` and `unsetController` first when ticked, then the registry's `transfer`. Wrapped: the wrapper's `safeTransferFrom`; the token carries the name's controller with it |
| Clean up | A wrapped name: `unwrap`, `unsetController`, `createWrapper`, `transfer`, `wrap`, so the token can be given away with no controller behind it |
| Wrap, unwrap | `createWrapper`, `transfer`, `wrap` (with `setController` first when the name has none), or `unwrap` |

A record counts only if it was written after the name last changed hands and after its last controller change (section Which records count), so wrapping, unwrapping and fixing a controller each end the records that counted. The plan writes those records again at the end, and says so. A change that fails halfway stops with the state it left and what to do next; the person is never asked to retry a step that already ran. One series runs at a time, because the wallet signs a whole series once.

**Art.** Each name has a card drawn on the page as an SVG, with nothing loaded from anywhere: a short label stays on one line, a longer one is split and its type shrinks to fit (a wide script is counted wider than a Latin letter), a right-to-left label reads from the right, and the colours come from the label itself.

**The Orivon ID badge.** For the connected account, and for the holder of a name on its page, the page asks the Orivon ID SDK (`namesOf`, `attribution`) which usernames the address holds and shows "Verified" when one has all four clauses in order: the address owns the username, no other account holds a role on it, the username resolves to the address, and the address can write its records. That proves one address controls a username in the ID registry now. It does not prove who a person is, that the ID's contracts are what they claim, or that the address will keep the username. Inside Orivon the ID's own scan reaches only the recent past, so a username typed in the card is checked on chain and remembered on this device, and checked again each time.

## Status

| Piece | State |
|---|---|
| `NAMES_0_1` resolve | Done: the name rules, the holder through registry and wrapper, the guard, the rule over census plus tail, every key but `contentcontract`, and the tests above |
| `NAMES_0_2` resolve and `setRecord` | Done. The declaration lists `codes: ["NAMES_0_1", "NAMES_0_2"]`, so the page provides both and an install holds it to the vectors of each (`test/names-conformance.test.ts` runs them as an install does). `setRecord` takes `contenthash` only, so an `ar://` site is written by the registration page itself, as `content.arw` |
| `contentcontract` (`web3://`) | Not answered: the browser has no record type for it yet. The census keeps the key for the names that have one |
| Census | Cut from chain by `tools/cut-census.mjs`; the file says its block |
| Run inside Orivon | Not yet run in a real Orivon: the tests drive the page against a stand-in for the browser's handles |
| Site page: search and register | Done: the four states, the records and why, the series with its checks, the tip and the private send, tested against a simulated Linagee and a mainnet fork |
| Site page: the names of an account, managing a name, name art, the Orivon ID badge | Done: the list from the wrapper's tokens, names added by hand and hints; every action above with its refusals and its checks; the badge; tested against a simulated Linagee, a mainnet fork and screenshots at two widths |
| Orivon ID sign-in to the site | Not built: it needs the ID's bridge files served from this site, which the tests here cannot exercise |
| Address lookups (sending to `x.og`) | Not built |

## Licences

- This directory is this repository's, [AGPL-3.0-only](../../LICENSE).
- [`site/resolver/vendor/ens-normalize.js`](site/resolver/vendor/ens-normalize.js) is `dist/index.min.js` of [`@adraffy/ens-normalize`](https://github.com/adraffy/ens-normalize.js) 1.11.1, MIT, with its licence beside it in [`ens-normalize.LICENSE`](site/resolver/vendor/ens-normalize.LICENSE). It is served as it is, unmodified. Distributing a build of this page owes that notice.
- `site/sdk/` is copied from `apps/id/site/sdk/`, this repository's own.
- The Linagee contracts are read, never copied or called from a contract of ours.

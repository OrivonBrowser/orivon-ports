# Port recon: ASGARDEX

**A page with a filing cabinet bolted to it.** The renderer imports no node builtin and no
`electron`, so nothing in the shell's shim families reaches it; but its preload is fourteen
globals and sixty-nine members, and thirty-three of those are a JSON file store. The port is one
capability — `orivon.fs` — spread across a wide surface, plus two groups refused by name.

Measured against `bc7b037d9875e6cfb1721bea577a16f72e1e02ea` (`v1.45.3`) on 2026-09-22. Line
numbers are that commit's.

## What the renderer does

| Fact | Evidence |
|---|---|
| Imports no node builtin, no `electron` | `orivon-port recon` over `src/renderer`, both counts zero |
| `fetch(` call sites | 6, plus axios over XHR everywhere else |
| Routing is hash-based | `src/renderer/App.tsx:2` — `HashRouter as Router`. No deep-link 404s, no SPA fallback needed |
| Node builtins are already stubbed out of the renderer bundle | `electron.vite.config.mjs:88-90` aliases `path`, `url`, `https`, `http`, `zlib`, `fs` to `empty.js` |
| Every `VITE_*` read has a working public default | `src/shared/utils/env.ts:13`'s `envOrDefault`; no `.env` is needed to build or run |
| Default API hosts allow cross-origin reads | `Access-Control-Allow-Origin: *` from Liquify's Midgard and THORNode gateways and from `mayanode.mayachain.info`, checked live |

## The preload: fourteen globals, sixty-nine members

`src/main/preload.ts` — every channel is a string literal, so this is the countable shape, not a
generic forwarder.

| Global | Line | Members | Called | What it is |
|---|--:|--:|--:|---|
| `apiKeystore` | 41 | 4 | 4 | wallet file, plus import/export through a native dialog |
| `apiExport` | 49 | 1 | 1 | balances JSON, through a native save dialog |
| `apiLang` | 54 | 1 | 1 | tells main to relabel the native menu |
| `apiUrl` | 63 | 1 | 1 | `shell.openExternal`, against an allowlist held in main |
| `apiHDWallet` | 68 | 7 | 7 | Ledger over `node-hid` |
| `apiCommonStorage` | 84 | 4 | 2 | settings |
| `apiUserNodesStorage` | 85 | 4 | 2 | |
| `apiUserBondProvidersStorage` | 86 | 4 | 2 | |
| `apiChainStorage` | 87 | 4 | 2 | |
| `apiAddressStorage` | 88 | 4 | 2 | |
| `apiAssetStorage` | 89 | 4 | 2 | |
| `apiPoolsStorage` | 90 | 4 | 2 | |
| `apiAppUpdate` | 98 | 1 | 1 | asks GitHub whether a desktop release exists |
| `apiMpc` | 168 | 26 | 23 | Vultisig MPC vaults, over a Node-only SDK |

**Called** is what a static read of `src/renderer` finds. The gap is `remove`/`exists` on the
seven stores and `dispose`/`getBalances`/`signBytes` on `apiMpc`: all six are in the app's own
`Window` declaration (`src/shared/api/types.ts`, `src/shared/api/mpcTypes.ts`), so the port
declares all sixty-nine. A member the app's own types promise is not one to leave absent.

`orivon-port recon` reports 40 rather than 69 here, and that is the tool being honest about a
known limit: it unions member names across globals, so the seven stores' identical `get`/`save`
collapse into two rows. Its own output says the count is a floor.

## The requirement nobody had written down

**The renderer trusts the main process to complete its settings object.**

`src/main/api/fileStore.ts:61` merges every read as `{ ...defaultValue, ...fileContent }` and
`:85` merges every write as `{ ...fileData, ...data }`, where `defaultValue` is
`DEFAULT_STORAGES` (`src/shared/const.ts:185`). So a save always resolves a **complete** record.

The renderer then replaces its whole in-memory state with whatever came back —
`src/renderer/services/storage/common.ts:161` — and reads each field as
`O.map(({ midgard }) => midgard)` then `O.getOrElse(() => DEFAULT_MIDGARD_URLS)` (`:47`).

Those two facts are safe together and unsafe apart, because the renderer sends **partial** saves:
`modifyStorage(O.some({ midgard: midgardUrls }))`
(`src/renderer/services/midgard/thorMidgard/service.ts:60`) and
`modifyStorage(O.some({ lastOpenedWallet: … }))` (`src/renderer/services/wallet/keystore.ts:94`).
A store that merged only against what it had on disk would hand back an object with `midgard` set
and `thornodeApi`, `mayanodeApi`, `locale` and the rest missing — and fp-ts does not rescue that.
`O.map` over a missing key yields `Some(undefined)`, not `None`, so `getOrElse` never fires and
each of those endpoints becomes `undefined`. Every client built from one then issues requests
against a relative URL, which on this port means the app's own origin: a wall of silent 404s, no
exception anywhere.

Of the seven stores, **`common` is the only one where this bites.** `userChains`, `userAssets`
and `pools` also send partials (`userChains.ts:51`, `userChainTokens.ts:70`, `pools.ts:29`), but
each omits only `version`, which no renderer consumer reads. `userNodes` and `userBondProviders`
send complete objects. So the port's storage rule is upstream's own: a read never rejects — with
nothing stored it resolves that store's `DEFAULT_STORAGES` entry, which is what keeps
`userChains$` and `userAssets$` off empty. `common` needs the copy in the bridge for a second
reason beyond that shared contract: its partial saves have to come back complete.

## What the main-process half needs, and why most of it is not portable

39 `ipcMain` handlers, grouped by what Orivon would have to be:

| Group | Handlers | What Orivon needs |
|---|--:|---|
| The seven JSON stores | 28 | `orivon.fs` under the app's own root. A direct fit — read, merge, write |
| Keystore wallets | 2 | `orivon.fs`. `wallets.json` is written and read back verbatim, already io-ts-encoded by the renderer |
| Keystore and balances file exchange | 3 | `orivon.fs.userSelected`. Upstream uses native dialogs (`src/main/api/keystore.ts:28,39`, `src/main/api/export.ts:7`) |
| External links | 1 | Nothing. The browser already opens a URL |
| Menu language | 1 | Nothing. There is no native menu left to relabel |
| App update | 1 | **Excluded.** An app asking whether a *desktop* release exists has no business doing so here; GitHub stays out of the manifest |
| Ledger over `node-hid` | 7 | **Excluded.** No device capability exists. Chromium has WebHID, but the app drives Ledger from main through `@ledgerhq/hw-transport-node-hid-singleton`, so reaching it would mean writing a Ledger transport into the bridge |
| Vultisig MPC vaults | 26 members, registered as one handler group | **Excluded.** `@vultisig/sdk` runs in the main process against Node |

### The escape test

The three file-exchange members are the ones to check, and all three pass:
`load` resolves **parsed JSON**, `exportKeystore` and `saveBalancesJson` resolve **void**. None
returns a host path, so each can be rebuilt over `orivon.fs.userSelected` with the handle kept
inside the bridge's closure. **Zero app edits.** As with FreeTube that is luck rather than design
— upstream happened to keep paths in main — but it is what keeps the port repeatable against the
next release.

## Verdict

**A target, and a different shape from the first port.** FreeTube was 34 members of which 3
needed a capability; ASGARDEX is 69 of which 33 do, all of them the same capability through two
small factories. The volume is in `refused` and `listeners`, which the porting guide predicts and
which the declarative member file absorbs.

The cost is not the member count. It is the two storage findings above — decisions invisible from
any stack trace, that a partial settings save has to come back complete and that a read with
nothing stored has to resolve upstream's own default rather than reject — and the two feature
groups that leave with a documented reason: no Ledger, no Vultisig vaults. The keystore wallet
path, which is what most people use ASGARDEX for, is whole.

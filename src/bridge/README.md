# `src/bridge/`: the bridge kit

A port declares what the app's preload exposed, and this composes the script the browser is
served. The declaration is `apps/<id>/bridge/members.json`; the app's own file supplies only the
members that carry a decision.

| File | Job |
|---|---|
| `declaration.ts` | The `members.json` schema and every rejection it produces |
| `catalog.ts` | Which behaviours exist, and the members each one installs |
| `compose.ts` | Preamble + behaviours + generated groups + the app's file, into one classic script |
| `runtime/preamble.js` | `BridgeError`, `refuse`, the listener recorder, the installer |
| `runtime/behaviours.js` | The behaviours themselves |

## One global, or several

A preload that exposed one name uses `global`, with the buckets beside it. One that exposed
several — ASGARDEX exposes fourteen — uses `globals`, one bucket set per name:

```json
{ "globals": { "apiChainStorage": { "hand": ["get", "save"] }, "apiMpc": { "hand": ["signBytes"] } } }
```

Declaring both forms is an error. Member names are scoped to their own global, because two of
them commonly share one: seven of ASGARDEX's fourteen are storage objects with the same four
members. That is also why `appMembers` returns a flat member map in the one-global form and one
keyed by global in the other — a flat map would silently keep one of the two `get`s.

## The buckets

| Bucket | What it is |
|---|---|
| `behaviours` | The browser already does it. Declare the catalog id and the app's own name for it |
| `listeners` | Inert. Record the callback the app hands over, never fire it |
| `noop` | A setter for state this port does not keep |
| `constants` / `asyncConstants` | A getter whose answer never changes. The `value` is emitted as a literal |
| `refused` | Named, with one of three reasons: `excluded`, `shell-owned`, `not-built` |
| `hand` | The members `apps/<id>/bridge/<file>.js` supplies, exactly |

## Design notes

**A `why` is required on anything that is not self-evident, and it is emitted as a comment.**
The porting guide's rule is that the comments are the deliverable: a generator can emit
`isWaylandPlatform: () => false`, but only a person can write down that the app's own
`DefinePlugin` compiles `process.platform` to `undefined`, so the guard around the one call site
never fires. Requiring the sentence and printing it above the member is how generation keeps that
property instead of destroying it.

**Generation is driven by a declaration a person writes, never by inference over the app.**
`docs/porting-guide.md` rejected a bridge generator on two grounds: it cannot decide semantics,
and it cannot be trusted to bind capabilities from the app's own code, which is the untrusted
party. Both hold here. `orivon-port recon --emit` writes names into `unclassified`, and a
non-empty `unclassified` refuses the port until a person has moved each one into a bucket.

**A behaviour enters `catalog.ts` because a real port needs it.** The same rule the shell's
`src/shim/` applies to Node surfaces. Seven exist because FreeTube's 34 members needed exactly
those seven; the eighth arrives with the app that calls for it, not before.

**The composed script is one classic, synchronous script, and the app's file is spliced rather
than imported.** Apps call bridge members at module top level, so the bridge has to exist before
the app's bundle runs its first line. That rules out a module, which rules out the app's file
importing the kit — so it declares `appMembers (kit)` and the composer puts it in the same scope.

**Two groups answering one member throws at install, before the app's bundle runs.** Merging
silently would make the bridge's behaviour depend on which group happened to merge last. The same
check catches a `hand` member the app's file forgot, or one it supplies without declaring, and
names the global as well as the member.

**A refusal names the object the app called.** `BridgeError` carries its owning global, so a
fourteen-global port's console says `apiMpc.signBytes is unavailable: ...` rather than naming
whichever global happened to be first.

**`getOrivon()` reads `window.orivon` at every call rather than capturing it at install.** A
grant that arrives later then works, and a declined one still refuses by name at the call site
instead of throwing while the page is loading.

**The kit is shared, and that is the exception `CLAUDE.md` rule 7 names.** Two ports sharing a
file is two apps that break together — which is why the *decisions* stay in each app's own
declaration, and only the mechanism is here. A recorder that records has no per-app semantics to
break.

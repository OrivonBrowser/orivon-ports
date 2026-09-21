## What this changes

<!-- One paragraph. If it is a new port, name the app and link its upstream. -->

## Why

<!-- The problem, or the app this makes reachable. -->

## Changes

<!-- One bullet per separately-findable piece: recipe, bridge, build wrapper, executor, docs. -->

## How it was verified

<!--
Paste what you ran. For a port, this must include driving it in a real Orivon window and
saying what you saw -- metadata loading is not playback.
-->

```
npm run typecheck && npm test && npm run check
node src/cli.ts run <app>
```

## Upstream, if this adds or changes a port

- Repository:
- Pinned commit:
- Licence:
- [ ] No upstream source or build output is committed
- [ ] `UPSTREAM.md` names the pin and the licence
- [ ] The app's own source is unmodified

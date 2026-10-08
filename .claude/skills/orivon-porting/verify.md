# Verifying a port

Unit tests and a loaded first screen are not verification. Every expensive miss in this
repository's history was a blank page with no console error, a spinner that never ended, or a skip
reported as a pass. The owner tests whole apps; verify the way they use them.

## The ladder

1. **Gates**: `npm run typecheck && npm test && npm run check`. A new test or gate is shown failing
   first: remove the fix or break the rule, watch it go red, restore.
2. **A fresh build**: `node src/cli.ts build <app> --rebuild` from an empty `out/<app>/`, in your
   worktree, through the heavy wrapper. A build from an old `out/` hides a broken pipeline.
3. **The served tree, by request**: serve on a spare port (`node src/cli.ts serve <app> --port
   <n>`) and `curl` the entry, a deep route, `.well-known/orivon.json`, the bridge, the icon. Each
   answers `200` with the right type.
4. **A real Orivon shell, headless**: below. This is the bar. A Node script against a fake
   `orivon` object passes where the real shell fails.
5. **The path users get**: when the app is or will be published, also the installed path and the
   `ipfs://` copy. The dev origin runs with no Orivon CSP and no size caps; WASM, `eval`, `blob:`
   workers and large chunks can fail only once installed.

## Driving the real shell

The owner's `npm run dev` watches `../orivon-mvp/out/`, so never build there:

```bash
git -C ../orivon-mvp worktree add --detach <scratch>/mvp origin/main
cp -al ../orivon-mvp/node_modules <scratch>/mvp/node_modules  # a symlink breaks shim bundles
cd <scratch>/mvp && ~/.claude/orivon-fleet/bin/heavy node scripts/build-ordinary.mjs
```

The ordinary build is what `npm start` runs: the real consent flow, with none of the developer-only
test hooks the e2e build carries. Write a throwaway spec in that worktree (never committed),
modelled on `../orivon-mvp/test/ported-apps/e2e-freetube-real.test.ts`, and run it with
`ORIVON_ORDINARY_BUILD=1` through `heavy node scripts/run-headless.mjs npx vitest run --config
test/vitest.e2e.config.ts <spec>`. A plain `.mjs` driver cannot import the harness's `.ts`
helpers. What the spec needs:

- The app at its loopback origin needs nothing more. To reach it at its `.eth` name instead, add
  `ORIVON_DEV_ORIGINS=1` and `ORIVON_ETH_NAMES_FILE=<ports>/out/names.json` (written by
  `node src/cli.ts names`), as `npm run dev` does.
- Answer the consent question with `answerEveryQuestion` or `answerQuestion`, and stub native
  pickers with `stubNativeDialogs` (`../orivon-mvp/test/support/question-support.ts`).
- Console, `pageerror`, failed requests and WebSocket frames recorded **before** the first
  navigation (`app.context().addInitScript`). Orivon's preload installs routed `fetch` over what an
  init script wrapped, so a recorder wraps it again on the first tick.
- The tab reloads once after the first grant: re-find the current view on every poll, and wait for
  first-run work on state, not a fixed sleep.
- `window.orivon` answers only a script the page itself loaded; call it through the harness's
  `asPage` helper, never `page.evaluate`.
- Every `evaluate` bounded by a timeout: a page reloading under you hangs one forever.
- Test the tab before consent and after it. The app tab after a grant is a different platform:
  property descriptors, CSP and routed networking change.

Kill only what you started, by PID (`pkill -f` matches its own shell). Remove the scratch worktree
afterwards. A spec in `../orivon-mvp/test/ported-apps/` that needs the ordinary build skips
silently unless `ORIVON_ORDINARY_BUILD=1` and that build exist: read the pass and skip counts.

## Assert the thing the app is for

Metadata loading is not playback. Name the app's main job and assert it end to end: a video's
`currentTime` advancing, a wallet created and its phrase confirmed, a message sent and received
over a real connection, a login that survives a reload. Where the job needs a server, run one
locally (a fake IRC server, a throwaway Matrix homeserver in Docker) rather than skipping the step.
Where it needs live third parties, gate the expensive assertion on what the prepared build
declares, with an environment override both ways.

## The whole-app sweep

When the owner reports one failure, or before a port is called done, drive every screen and flow,
not the reported one:

1. **Enumerate** from the app itself: its router table, menus, settings pages, onboarding, import
   and export, every action that writes. Write the list down first.
2. **Drive each** headless, from a fresh profile (first run) and after a relaunch on the same
   profile (persistence).
3. **Classify each failure**: a port bug, an Orivon gap, upstream's own behaviour, live network
   state, a third party's limit. Reproduce suspected upstream behaviour in upstream's official app
   before fixing anything: when the official app fails the same way, there is nothing to fix.
4. **Report a table**: screen, result, cause, what was done. Say so when the owner's exact failure
   could not be reproduced and the cause is inferred.

General-purpose apps take any input a user can give: any server, any network, any port. A manifest
or a test built on a named list of hosts passes review and fails the owner within the hour.

## Reading results

- **A skip is not a pass.** The real-app specs, and anything behind `skipIf`, skip without their
  build. Count them.
- **`| tail` hides the exit code** and buffers output until the end. Log to a file and read it.
- **A pixel-only QA difference** is usually another session's UI change on main: compare against an
  `origin/main` build before suspecting yours.
- **Failure evidence** of an mvp e2e run is in `qa-artifacts/latest/` there: the screenshot, the
  console, the main-process log. The `orivon-qa` skill in orivon-mvp says how to read it.

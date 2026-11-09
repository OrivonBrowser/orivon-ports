# Upstream: Super Productivity

| | |
|---|---|
| Source | `https://github.com/super-productivity/super-productivity` |
| Pinned commit | `4db0e11236bc784d3184a9e252930b4bd53df823` (release `v20.0.0`) |
| Licence | MIT |

## What "Electron" means for this port

Super Productivity's desktop renderer is, byte for byte, the Angular build its web app is made of:
`npm run buildFrontend:prod:es6` (`ng build --configuration production`) is what the Electron
packaging step takes its `index.html` from, and the web release differs only by output folder. What
makes that build the *desktop* app is a run-time decision in `src/app/app.constants.ts`:
`navigator.userAgent` contains ` electron/` and `window.ea` exists. This recipe builds the renderer
with upstream's own script, and [`bridge/superproductivity.js`](bridge/superproductivity.js) and
[`bridge/members.json`](bridge/members.json) supply both halves of that decision inside Orivon, in
place of `electron/preload.ts` and the main process.

## What crosses into this repository

**Nothing of Super Productivity's.** The clone lives in `superproductivity/source/` in the build folder and the
build output in `out/superproductivity/static/`, neither tracked and both reproducible from
[`recipe.json`](recipe.json). `npm run check:no-upstream` fails the build if either is ever tracked.

What is ours, and written from scratch:

- [`recipe.json`](recipe.json) and [`orivon.json`](orivon.json)
- [`bridge/members.json`](bridge/members.json), which names the 80 members of `window.ea` and says
  how each is answered, and [`bridge/superproductivity.js`](bridge/superproductivity.js), which
  implements the six that carry a decision, adds the Electron token to the user agent and guards
  against a second tab. They re-create the *shape* of `window.ea`: member names and arity read off
  `electron/electronAPI.d.ts` and the renderer's call sites, backed by the page instead of IPC.
  None of upstream's code is copied.
- [`bridge/plugin-frame.js`](bridge/plugin-frame.js), which runs the inline scripts and event handlers
  of a plugin's page, and the rewrite of that page's document in `bridge/superproductivity.js`. Both
  are ours; the plugin's own code is whatever the app loaded and never passes through this repository.
- [`hooks.mjs`](hooks.mjs), which edits the built `index.html` so that its three inline scripts run
  from files and a stylesheet that waits on one of them applies at once, and writes one static page
  and `plugin-frame.js` beside the app.
  The scripts' bytes come from `out/`; none are written here.

## Bundled plugins

The build ships 25 plugins in `assets/bundled-plugins/<name>` (24 in Settings, Plugins, and a developer
test plugin the app hides), all produced by upstream's own `packages/plugin-dev/scripts/build-all.js`
from sources in the same repository at the pinned commit, `packages/plugin-dev/<name>`. This repository
adds none and changes none.

- **Built from TypeScript sources in `src/`** (20): ai-command, ai-productivity-prompts, app-auto-track,
  automations, azure-devops-issue-provider, caldav-calendar-provider, clickup-issue-provider, doc-mode,
  gitea-issue-provider, github-issue-provider, gitlab-issue-provider, google-calendar-provider,
  linear-issue-provider, nextcloud-deck-issue-provider, procrastination-buster, redmine-issue-provider,
  sync-md, ticktick-import, todoist-import, trello-issue-provider.
- **Plain JavaScript kept in the repository and shipped byte for byte** (5): api-test-plugin, brain-dump,
  parallel-code, voice-reminder, yesterday-tasks-plugin. The `plugin.js`, `index.html` and `manifest.json`
  of each equal the shipped files.

All of it is under upstream's MIT licence. Whether a plugin is open source is a fact about its directory
there, so it is re-read when the pin moves.

## What we never do

- **Edit Super Productivity's source.** The port needs zero app edits; that is what keeps it
  repeatable against the next release.
- **Fork its build.** The recipe runs upstream's own `buildFrontend:prod:es6` script.
- **Ship its secrets.** The build sets none of the optional keys `tools/load-env.js` reads (Dropbox,
  OneDrive, Google Drive, Unsplash). The sync dialog still lists Dropbox and OneDrive; a provider that
  needs one of those keys is not expected to work.

## Redistribution

This repository distributes none of Super Productivity, so its MIT notice does not reach the recipe.
A built tree is a copy of an MIT work: it carries upstream's licence text as `/LICENSE`
(`extraFiles` in the recipe), and each copy keeps it.

## When the pin moves

Re-read `electron/preload.ts` at the new commit against `bridge/members.json` (a new member is
invisible to `orivon-port recon --emit`), check `src/app/app.constants.ts` still decides
`IS_ELECTRON` from the user agent and `window.ea`, and check `src/index.html` still has exactly three
inline scripts and the `media="print" data-beasties-media="all"` stylesheet pattern (`hooks.mjs` throws
when it does not), that the plugin page is still `<iframe data-plugin-iframe [srcdoc]>` built by
`src/app/plugins/ui/plugin-index/plugin-index.component.html` from a string that holds the plugin's
`index.html` and an inline API script (`util/plugin-iframe.util.ts`), that every directory of `packages/plugin-dev` still holds its sources, and that `.nvmrc` and the Angular CLI's minimum still name a Node the build machine has.

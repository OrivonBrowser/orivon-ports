# Ollama GUI port reconnaissance

Read against **HelgeSverre/ollama-gui** at `b79a7b8ca537037d1985c69109260ff540b88170` (release
`v2.0.5`, the tip of the default branch), from a local clone. Paths are relative to that tree.

## The shape: a Vue web app with no Electron build

Ollama GUI is a Vue 3 + Vite single-page app. It has no Electron target, no preload and no
`ipcMain`, so there is no bridge to write: `package.json` has no `electron` dependency, `src/` imports
no Node builtin, and the only `window.*` surface it touches is the web platform's own.

| Fact | Evidence |
|---|---|
| Build | `package.json` `build`: `vue-tsc -b && vite build`, output `dist/` |
| Package manager | `bun.lock` only (lockfileVersion 1); CI installs with `bun install --frozen-lockfile` |
| Routing | none: one view, no history routes, so no `_redirects` is needed |
| The only network peer | Ollama's HTTP API: `src/ollama/client.ts` `send()` is a plain `fetch(`${resolveHost()}/api/${path}`)` |
| Default host | `resolveHost()` falls back to `http://localhost:11434` in a production build; the user can change it in Settings (`input-base-url`) |
| Streaming | `streamJson()` reads `response.body` through `TextDecoderStream` and splits NDJSON lines |
| Storage | IndexedDB (Dexie) and `localStorage`; no file access |
| Service worker | `vite-plugin-pwa` registers `sw.js` with `registerType: 'autoUpdate'` |
| Export / import | `URL.createObjectURL` download, file input upload (`src/composables/useTransfer.ts`) |

## Build choices

- **Relative base.** The recipe builds with `--base ./` so every URL in the built page (scripts, styles,
  icons, `registerSW.js`, the service worker's registration and scope) is relative to the entry
  document, and the tree survives being mounted under a prefix. Vite's `--base` is a build option, not a
  source edit. The web app manifest's three icon `src` values stay root-absolute because
  `vite.config.ts` writes them that way; they matter only to an "install this site" prompt.
- **Package manager.** `npx --yes bun@1.3.14` runs the install and the build, so no `bun` on the host is
  assumed. The lockfile is frozen.
- **Licence.** MIT, in `LICENSE.md`; the recipe copies it to `/LICENSE` in the served tree.

## Verdict

A web build is correct (there is no Electron renderer to prefer), no bridge is needed, and the manifest
declares one thing: a connection to `localhost:11434`.

# WebTorrent

**What lives here.** WebTorrent Desktop, the streaming torrent client, as an Orivon app: a recipe, a
manifest, the build that bundles upstream's own renderer code, and the stand-in for its main process.
**No WebTorrent Desktop source and no build output is in this repository**: see
[`UPSTREAM.md`](UPSTREAM.md) for its licence and pin.

It is the whole client, not the browser build of webtorrent: TCP peers, the DHT, UDP, HTTP and
WebSocket trackers, peer exchange, WebRTC peers, encrypted connections, and the player streaming from
upstream's own HTTP server inside the page. Both of upstream's windows (the hidden torrent window and
the main window) run in one page, with Node's networking and files provided by orivon-mvp's shim.

## Running it

```bash
orivon-port run webtorrent
```

Then open `http://127.0.0.1:8877` in Orivon and accept the prompt, or `webtorrent.orivonstack.eth`
with the names file (the repository [`README.md`](../../README.md), Opening it by name).

## What it is granted, and why

| Grant | Why |
|---|---|
| `net.tcp.connect: *:*` | Peers and HTTP trackers can be any computer on the internet. |
| `net.tcp.listen.network: 49152-65535` | Incoming peers, and the streaming server the player plays from. Upstream listens on every interface on a port the system picks; Orivon picks one in this range. |
| `net.udp.bind.network: 49152-65535`, `net.udp.send: *:*` | The DHT and UDP trackers, which must hear back from the internet. |
| `net.https.connect: *:*` | HTTPS and WebSocket trackers, and web seeds. |
| `net.concurrentSockets: 200` | A swarm: up to 55 peers a torrent, plus trackers and the DHT. |
| `fs.quotaBytes: 50 GiB` | Downloads, which are in the app's own files. |

## How it is built

- **Node resolution, as Electron's `require()` resolves under `nodeIntegration`.** The bundle is built
  with esbuild's `platform: 'node'`, so no package's `browser` field applies. webtorrent's own
  `browser` field maps its connection pool, the DHT, peer exchange, its HTTP server and every UDP
  tracker to nothing, which would leave a WebRTC-only client that cannot stream to its player.
  `build-plan.js`'s `REQUIRED_INPUTS` fails the build if any of them is missing.
- **Every Node builtin and `electron` is orivon-mvp's shim**, through its esbuild plugin
  (`ORIVON_MVP_ROOT`, else `../orivon-mvp`). Upstream's own modules get `electron.js`, which adds
  `remote` (below).
- **One page.** `page-entry.js` loads the main-process stand-in, then upstream's torrent window, then
  its main window, in the order Electron starts them. orivon-mvp's `ipcRenderer` and `ipcMain` are one
  in-page bus, so the windows' `wt-*` messages reach each other directly; no channel is heard by both.
- **The files upstream reads from its install.** Each upstream module sees the `__dirname` it would
  have in an install at `/orivon/app/webtorrent-desktop` (`moduleScope`), and `install.js` copies the
  default torrents and their posters there before the app starts, once per build (`install.json`).
- **Sloppy CommonJS, as Node runs it.** esbuild applies the nearest `tsconfig.json` to JavaScript
  too, and this repository's is strict, so the build writes a non-strict one beside the clone and
  gives the bundle a CommonJS entry under none. Upstream relies on sloppy mode: `showDoneNotification`
  reads `this.state` from `window`, and `torrentPosterFromVideo` passes `0` as an options object.
- **Posters from a video frame** (`poster-capture.js`). Upstream draws a frame of a video from a second
  streaming server of its own, which Electron's `file://` page may read. Here the server is another
  origin, so that server gets webtorrent's default options (every origin may read it, as the player's
  server already allows) and a video pointed at a loopback server by its `src` property asks with CORS.
- **The build fails** when upstream's windows send main a channel `main-process.js` does not answer,
  when its entry document changes shape, or when a refused package reaches the bundle.

## The main process

`main-process.js` answers each channel upstream's windows send to main; `remote.js` answers
`@electron/remote` and `electron.remote`, which upstream's main window still reads (Electron 14 removed
it; the replacement module is the same thing).

| Upstream asks main to | Here |
|---|---|
| Open a `.torrent` (`openTorrentFile`) | The page's file picker; each file is added as the `File` it is |
| Open files (`openFiles`, the + button) | The picker; `.torrent` files are added, other files are copied into the app's files (`/orivon/app/Imported/`) and open Create Torrent, as upstream's paths would |
| A drop of files or folders to seed, or of subtitles (the OS's paths, under Electron) | Copied in the same way, then given to upstream's own `onOpen` (`drop.js`); a drop of `.torrent` files or of a magnet link reaches upstream's handler as it is |
| Show in Folder, open a file (`showItemInFolder`, `openPath`) | Copies the file or folder out to a folder the person picks: the app's files cannot open in another program |
| Remove Data File (`moveItemToTrash`) | Deletes the data; the app's files have no trash |
| Save Torrent File As (`showSaveDialogSync`) | Answers a path in the app's files, and hands what the app writes there to the person as a download |
| Open subtitles (`showOpenDialogSync`) | Answers "cancelled" at once (no picker can block), shows the picker, copies the pick in and adds it with upstream's own `addSubtitles` |
| Save the state before quitting, so torrents resume (`stateSaveImmediate`, awaited on quit) | Saved whenever the page is hidden, which a closing tab is first, and every 30 seconds: a tab can close at any moment |
| Keep the screen on while playing (power save blocker) | `navigator.wakeLock` |
| Full screen (`toggleFullScreen`) | The page's own full screen, reported back as `fullscreenChanged` |
| Window title (`setTitle`) | `document.title` |
| A context menu (`remote.Menu#popup`) | A menu drawn in the page at the pointer (`context-menu.js`) |
| The dock, the taskbar, the menu bar, the window's size and position | Nothing: a tab has none of them |

## What this port does not do

Each one says why in the app's own error bar when the person asks for it, or is answered as the
same app would answer it on a computer that lacks the thing:

- **Casting** to Chromecast, AirPlay or DLNA, and **local peer discovery** (BitTorrent's LSD): both need
  multicast UDP, which Orivon's `dgram` does not offer. The cast menu finds no device; local discovery
  is off, as in webtorrent's own browser build.
- **uTP**: its only implementation is a native addon (`utp-native`). Peers are reached over TCP and
  WebRTC.
- **An external player** (VLC): Orivon starts no program on the computer. "Play in VLC" reports VLC
  as not found.
- **Opening magnet links and `.torrent` files with WebTorrent**, **starting at login**, **watching a
  folder** for new `.torrent` files, and **choosing a download folder** or a program on the computer:
  none of these exists for an Orivon app. Downloads go to `/orivon/app/Downloads` in the app's own files.
- **The menu bar and its shortcuts** (open a `.torrent`, open an address, create a torrent): upstream
  builds them in main, and a tab has no menu bar. Every one is also in the page: the + button, and
  pasting a magnet link or dropping a `.torrent` anywhere.
- **Posters and sounds.** Upstream shows a poster from a path in its config folder and plays sounds
  from `file://` URLs; a page reaches neither yet (What it needs from orivon-mvp). The list shows each
  torrent without its picture, and no sound plays.
- **The audio track menu.** Upstream turns on Chromium's `AudioVideoTracks` in its window, and a tab
  has it off; video and its default audio play.
- **Telemetry and update checks**: upstream sends them only from a production Electron build, which
  this is not, and its update check runs in main.

## What it needs from orivon-mvp

Catalogue rows in orivon-mvp's `test/app-behaviours/catalogue.md` this port relies on, so a break there
is recognised as this port's:

- `loopback-manifest-hint-grants-the-origin`, `plain-http-grant-is-session-scoped`: the grant.
- `page-sync-fs-writes-land`: upstream's first start creates folders and copies files synchronously.
- `node-fs-writes-land-at-app-root`, `app-files-survive-restart`, `fs-quota-refuses-past-limit`:
  downloads and the saved state.
- `page-media-from-own-listener`, `local-listener-accepts-connections`: the player plays from the
  page's own streaming server.
- `secure-context-on-app-origin`, `wake-lock-request-settles`, `window-open-noopener-opens-tab`,
  `user-picked-file-and-folder-handles` (Show in Folder), `concurrent-sockets-limit-holds`.

Not yet proven there (*provisional* until each has a row and a spec): `tcp.listen.network` and the
`udp.*` kinds (the DHT, UDP trackers), which the catalogue's coverage table marks not covered because
no port relied on them before this one; and the shim's `constants` module, `O_CREAT` opens and queued
file and socket calls, and `electron`'s `clipboard` and `shell.openExternal` (pasting a magnet link,
copying one, the links in the app).

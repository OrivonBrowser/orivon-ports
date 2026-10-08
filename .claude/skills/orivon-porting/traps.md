# Traps that cost a session an afternoon

Each line is a symptom, its cause, and what to do. A trap true of one app only belongs in that
app's README Design notes instead. Add to this page when a session pays for something a later
session would pay for again.

## A page that is blank, white or stuck, with no error

- **White after consent, fine before it.** The tab becomes an app tab after the grant and its
  globals change. A library that assigns to a global through a prototype chain (`F.prototype =
  window; this.fetch = ...`) throws in a module's strict mode when the inherited property is not
  writable, and nothing names it. Attach `pageerror` before navigating; compare both tabs.
- **Blank on a gateway, fine locally.** Compressed bytes the local server decoded, a server fallback
  for history routes, or a root-absolute URL that escapes a `/ipfs/<cid>/` mount. `src/portable.ts`
  and `_redirects` are the answers (guide section The output has to survive a host that does
  nothing).
- **Fine on the development origin, broken once installed.** The dev origin carries no Orivon CSP
  and no size caps. WASM, `eval`, `new Function`, `blob:` workers and big chunks fail only once
  installed, and a `new Function` install fails silently under a strict CSP.
- **A spinner forever on first run.** The bridge rejected a read that upstream's main process
  answers with a default; the renderer turned it into an empty list. See
  [new-port.md](new-port.md) step 5.
- **A flow that hangs.** A refused member the app awaits on every run (a search index deleted at
  login) breaks the flow: answer what upstream answers when the feature is absent ("not installed").
- **Quirks-mode layout.** Anything injected into the HTML before the doctype. `prepare` matches
  `<head\b`, not `<head` (which also matches `<header>`): keep it so when editing `src/prepare.ts`.
- **An Electron call that throws a bare `TypeError`.** The shim's stand-in for that `electron` API is
  partial; `../orivon-mvp/docs/planning/compatibility/table-2b-electron.md` says what exists.

## Building

- **A copy rule writing outside the port's output.** Upstream webpack's `CopyWebpackPlugin` with an
  absolute `to:`, or `output.copy`, ignores `output.path`. `retargetOutput` throws on any that
  escapes; extend it, never silence it.
- **The desktop icon missing from the renderer build.** Vite does not copy `public/` into a
  renderer-only output, and desktop icons live in `resources/` or `_icons/`. `extraFiles` copies it.
- **A server bundled from `dist/`.** tsc's CommonJS output turns computed `import()` into `require`
  a bundler cannot follow, and handlers vanish without an error. Bundle the TypeScript sources with
  esbuild, `platform: 'node'` (`'browser'` swaps in transports that throw). The guide's Node server
  apps section has the rest: the glob-extension gate, `sqlite-ready` first, `shimAssets()`.
- **Features missing at run time, "CORS error" in the console.** A build-time API key was not set,
  or a third party answered 429. Check the response body: some APIs answer 200 with a rejection.
- **`npm ci` failing on GitHub with a 500 during the Electron download.** A flake: rerun the job.

## The bridge

- **A helper named like a kit function** (`refuse`, `recorder`, `kit`, `exposed`) at the bridge's top
  level redeclares the kit's own in the shared scope and silently replaces it. Keep helpers inside
  `appMembers`.
- **`instanceof` across the test harness.** The `node:vm` sandbox has its own realm; compare errors
  by `name`.
- **A grant test that checks the declaration only.** Run the manifest through the same parse and
  connect check Orivon runs; `apps/the-lounge/bridge/grants.test.ts` is the shape. A preflight-only
  test passed a manifest that could not reach the network.

## Network and grants

- `*:*` never reaches loopback or private addresses, nor a reserved port (6667, 6697) unless a
  pattern names it exactly. A TLS dial is checked against `https.connect`, not `tcp.connect`.
- A local listener is IPv4: tell the app `127.0.0.1`, not `localhost`.
- A TLS failure against a self-signed server: run upstream on plain Node first. When Node fails the
  same way, the app's own setting is the answer and Orivon's only possible bug is the error text.
- A live service failing (a halted chain, a dead public instance, a minimum amount) looks like a port
  bug. Reproduce in upstream's official app before fixing anything.

## This machine and these repositories

- **The heavy-command hook matches words in command text**, heredoc bodies and commit messages
  included. Write scripts, PR bodies and commit messages to files with the Write tool and pass the
  file.
- **`pkill -f <pattern>`** matches the shell running it and kills your own command. Use PIDs.
- **`| tail`** hides the exit code and buffers a long command's output until it ends.
- **A symlinked `node_modules`** in an mvp worktree breaks the shim's bundles; use `cp -al`.
- **`check:no-upstream` reads `git ls-files`**: an untracked file passes until it is staged. Stage
  new files before trusting the guard.
- **`vitest run <path>` that matches nothing exits 0**, and `orivon-port test` on an app with no
  tests runs nothing. Read the file count.
- **GitHub code search rate-limits recon.** Clone, or read `raw.githubusercontent.com`.
- **The pinning host's shell**: each SSH session has its own `/tmp`, long background commands die
  with the session, heredocs break over SSH (copy a script, then run it), and a copy loses the
  executable bit.
- **The owner's uncommitted files** (in either repository) never go into your commits. Stage paths
  by name.
- **A direct push to `main` here may be refused** by the session's permission layer. Push a branch,
  open a PR, merge it when green.
- **A feature nobody can turn on is a bug.** When a port needs an environment variable or a command
  to work, the tool prints it and the README says it.

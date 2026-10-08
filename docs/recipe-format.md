# `recipe.json`

One file per app. For a port it says where the app is, at which commit, how to build it, and
what to add so the result is an Orivon app. `orivon-port new <id>` writes a filled-in skeleton
for a port. An app written in this repository has no upstream and no build, and its recipe
names the directory it is served from instead: see [A `site` recipe](#a-site-recipe).

Every rejection names the field, so a wrong recipe tells you which line to fix.

## The fields

| Field | Required | What it is |
|---|:--:|---|
| `id` | yes | Lowercase letters, digits and dashes. It is a directory name in three places, so nothing else is accepted |
| `name` | yes | What a person calls the app |
| `port` | yes | 1024–65535. **One origin per app** — a grant attaches to the origin, so two apps on one port would share permissions. `check:pinned` rejects a duplicate |
| `eth` | no | A development `.eth` name — lowercase labels plus `.eth`, e.g. `freetube.orivonstack.eth`. An app whose manifest names a `domain` takes that name here (`check:manifest` fails otherwise), because a Web3 Score provider's judged level counts only at the manifest's `domain`: under any other name the app in development shows a different level from its published build. This is not name resolution: it is a name `orivon-port names` steers at the app's own port, and while the shell honours it, it shadows the real ENS name of the same spelling. Session-scoped like any plain-`http` grant — see the app's own README. `check:pinned` rejects a duplicate the same way it rejects a duplicate port. Steered with `--host-resolver-rules`, not a PAC — a `file://` PAC url did not take effect against a real Electron 44 window in testing, while `--host-resolver-rules` reached both the default session and a partitioned one identically. **The name resolves to nothing until the shell is launched with `ORIVON_ETH_NAMES_FILE` set** — [`README.md`](../README.md)'s "Opening it by name instead of by port" has the exact command; there is no default, and nothing infers it |
| `site` | no | An app written in this repository: the directory, relative to the app directory, that is served as it is. It replaces `upstream` and `build`, and cannot sit beside any field that fetches, builds or patches something. See [A `site` recipe](#a-site-recipe) |
| `upstream.repo` | yes, for a port | An `https://` git URL |
| `upstream.ref` | yes, for a port | A **full 40-character commit sha**. A branch or tag makes the build unreproducible, so it is rejected |
| `upstream.licence` | yes, for a port | SPDX id, from the allowlist in `scripts/check-licences.ts`. A licence not on that list needs a person to decide, and adding it is that decision being recorded |
| `install` | no | POSIX `sh` command run in the source tree before the build |
| `build.command` | yes, for a port | POSIX `sh` command run in the source tree |
| `build.output` | yes, for a port | Where the build writes, relative to the source root |
| `build.also` | no | Further commands, run in order after the build |
| `manifest` | yes | Path to the Orivon manifest, relative to the app directory |
| `entry` | no | The HTML document inside `build.output`. Default `index.html` |
| `bridge.members` | no | The member declaration, relative to the app directory. The executor composes it into the served bridge — [`src/bridge/README.md`](../src/bridge/README.md) |
| `bridge.file` | no | The app's own bridge members. With `members`, it supplies the `hand` members and is spliced into the composed script; without it, it is a complete bridge script copied as it is. Required when any global declares a `hand` member |
| `extraFiles` | no | `[{ from, to }]` — `from` is relative to the source tree, `to` to the served tree |
| `hooks` | no | A `.mjs` file exporting `transformHtml(html, context)`, for HTML surgery the fields above cannot express |

An unknown field is an error, not something ignored: a typo in a field name is otherwise a
setting that silently does nothing.

## The manifest's `domain` and `version`

Every published app's `orivon.json` names the one place it is addressed from, in `domain`: an ENS
name or a DNS host such as `freetube.orivonstack.eth`. A build of Orivon that reads `domain`
rejects a manifest whose domain is malformed, trusts a judged level for the app's content only at
that name, and offers a new version to a person who opened the app there. *Provisional*: the
client reading `domain` is not on its main branch yet, and landing it settles this paragraph.

`domain` is one lowercase host exactly as a URL spells it: two labels at least, 253 characters at
most, each label letters, digits and inner hyphens and 63 characters at most. No scheme, port,
path, IP address, numeric top-level label, `localhost` or `*.orivon` name.
`check:manifest` requires it and applies that shape. `bisq-fake`, a mock that is never published,
is the one app exempt, by name, in `NO_DOMAIN_APPS` in `src/manifest-domain.ts`, and it must not
carry one. `orivon-port new` writes `<id>.orivonstack.eth`; change it to the name the app is
published at.

A ported app's `version` is `<upstream>.<build>`: the upstream release, then a build number that
starts at 1 and rises when this repository republishes the same upstream release (`0.25.3.1`
sorts above `0.25.3`). An app written here keeps its own version. The app's in-app update checker
is left as upstream wrote it: it compares upstream releases and cannot see a build number.

## Tokens in commands

A command runs on a machine whose paths nobody can predict, so it names directories by token:

| Token | Expands to |
|---|---|
| `{recipe}` | `apps/<id>/` |
| `{source}` | `out/<id>/source/` |
| `{static}` | `out/<id>/static/` |

Each expands single-quoted, so a checkout path with a space in it stays one argument:
`--config {recipe}/w.cjs` reaches the shell as `--config '/home/jo/orivon-ports/apps/x'/w.cjs`.
Write a token bare, never inside quotes of your own.

An unknown token is an error rather than a silent empty string — `rm -rf {oout}/x` expands to
`rm -rf /x` under a substitution that leaves unknowns alone.

## Commands are POSIX `sh`, on every platform

A recipe is written once, so `install`, `build.command` and `build.also` are POSIX shell on
Linux, macOS and Windows alike: `VAR=x cmd`, `&&`, single quotes and `rm -rf` all work. On
Windows the executor runs them in the bash that ships with Git for Windows, found beside `git`;
`cmd.exe` is never used. `ORIVON_PORTS_SHELL` names a different shell on any platform, and
`orivon-port doctor` reports which one this machine uses.

## What `build` runs, and where

`install`, then `build.command`, then each of `build.also`, all with **the source tree as the
working directory**. That is the app's own tree, so its own `npx`, its own lockfile and its own
node_modules are what resolve.

After the build, the executor checks that `build.output/<entry>` exists. A build that reports
success and produces no entry document is the most common recipe mistake, and the error names
the path it looked for.

## An example

[`apps/freetube/recipe.json`](../apps/freetube/recipe.json), in full. It wraps upstream's own
webpack config rather than forking it, which is why `build.command` names `{recipe}`:

```json
{
  "id": "freetube",
  "name": "FreeTube",
  "port": 8875,
  "eth": "freetube.orivonstack.eth",

  "upstream": {
    "repo": "https://github.com/FreeTubeApp/FreeTube.git",
    "ref": "60e9d7fa186d2cad88f999e5b728cad0fa2e420c",
    "licence": "AGPL-3.0-or-later"
  },

  "install": "pnpm install --frozen-lockfile",
  "build": {
    "command": "npx webpack --mode=production --config-node-env=production --config {recipe}/webpack.orivon.config.cjs",
    "output": "dist/orivon-electron-web",
    "also": ["pnpm run pack:botGuardScript"]
  },

  "manifest": "orivon.json",
  "bridge": { "members": "bridge/members.json", "file": "bridge/ft-electron.js" },
  "hooks": "hooks.mjs",
  "extraFiles": [
    { "from": "dist/botGuardScript.js", "to": "orivon/botGuardScript.js" },
    { "from": "_icons/iconColor.png", "to": "orivon/freetube-icon.png" }
  ]
}
```

## The bridge

`bridge.members` names a declaration; `bridge.file` names the app's own members. Together they
produce one classic script, served at `/orivon/<global>-bridge.js` and injected first in
`<head>`.

```
apps/freetube/bridge/
  members.json      32 of the 34 members, by name and by the reason each is answered that way
  ft-electron.js    the 2 that carry a decision, as `function appMembers (kit)`
```

[`src/bridge/README.md`](../src/bridge/README.md) is the declaration format, the behaviour
catalog and the two-global forms. A port with no declaration still works: `bridge.file` alone is
copied to `/orivon/<name>` unchanged.

## A `site` recipe

Not every app in `apps/` is somebody else's. A page written here, such as the
[`apps/bisq-fake/`](../apps/bisq-fake/) mock, has nothing to clone and nothing to build, so its
recipe has no `upstream` and no `build`:

```json
{
  "id": "bisq-fake",
  "name": "Bisq (mock)",
  "port": 8885,
  "eth": "bisq.eth",
  "site": "site",
  "manifest": "orivon.json"
}
```

`run` and `build` skip the clone and the build and go straight to `prepare`, which copies
`apps/<id>/<site>/` into the served tree and adds the manifest, the discovery hint and the Orivon
hint, exactly as it does for a port. It prepares the tree again on every run, because a copy is cheap and there is
no ref to compare against. `fetch` refuses a site.

`install`, `build`, `bridge`, `extraFiles` and `hooks` are rejected beside `site`. The page is
ours, so a change it needs goes into the page itself, and it calls `orivon.*` directly rather
than through a bridge. `check:licences` skips a site, since there is no third-party licence to
state, and `check:no-upstream` admits only `.html`, `.css`, `.js` and `.svg` files under the
declared directory: a font or an image is still somebody else's work. The one exception, named
in `scripts/app-files.ts`, is Explore's `site/icons/*.png`: each listed site's own icon, whose
source `apps/explore/UPSTREAM.md` records.

A site's unit tests live in `apps/<id>/test/<name>.test.ts`, beside `site/` rather than in it, so
they are never served or published; `check:no-upstream` admits that one shape there.

## When the fields are not enough

`hooks` is the escape hatch, and it exists so the format does not have to grow a field for every
app's particular quirk. It exports one function:

```js
export function transformHtml (html, { recipe, dirs }) {
  return html.replace('</body>', '<iframe id="thing"></iframe></body>')
}
```

It runs **before** the manifest hint, the bridge script and the Orivon hint are injected, so those
always end up where they belong regardless of what a hook does. Make it idempotent: `prepare` may run twice.

It may be `async`, and `dirs.static` is the served tree it is working on, so a hook that takes
something out of the HTML can write it beside the page, as a file the hash then covers. FreeTube's
uses that to move its inline sigFrame script to `orivon/sig-frame.js`. A hook never edits the
app's own bundles: the bytes a build produced are what the tree serves.

# `recipe.json`

One file per port. It says where the app is, at which commit, how to build it, and what to add
so the result is an Orivon app. `orivon-port new <id>` writes a filled-in skeleton.

Every rejection names the field, so a wrong recipe tells you which line to fix.

## The fields

| Field | Required | What it is |
|---|:--:|---|
| `id` | yes | Lowercase letters, digits and dashes. It is a directory name in three places, so nothing else is accepted |
| `name` | yes | What a person calls the app |
| `port` | yes | 1024–65535. **One origin per app** — a grant attaches to the origin, so two apps on one port would share permissions. `check:pinned` rejects a duplicate |
| `eth` | no | A fake `.eth` name — one lowercase label plus `.eth`, e.g. `freetube.eth`. Real Orivon apps are addressed by URL, not installed, so this is not name resolution: it is a name `orivon-port names` can steer at the app's own port, for driving the shell by name instead of by port number while trustless resolution does not exist yet. Session-scoped like any plain-`http` grant — see the app's own README. `check:pinned` rejects a duplicate the same way it rejects a duplicate port. Steered with `--host-resolver-rules`, not a PAC — a `file://` PAC url did not take effect against a real Electron 44 window in testing, while `--host-resolver-rules` reached both the default session and a partitioned one identically. **The name resolves to nothing until the shell is launched with `ORIVON_ETH_NAMES_FILE` set** — [`README.md`](../README.md)'s "Opening it by name instead of by port" has the exact command; there is no default, and nothing infers it |
| `upstream.repo` | yes | An `https://` git URL |
| `upstream.ref` | yes | A **full 40-character commit sha**. A branch or tag makes the build unreproducible, so it is rejected |
| `upstream.licence` | yes | SPDX id, from the allowlist in `scripts/check-licences.ts`. A licence not on that list needs a person to decide, and adding it is that decision being recorded |
| `install` | no | Shell command run in the source tree before the build |
| `build.command` | yes | Shell command run in the source tree |
| `build.output` | yes | Where the build writes, relative to the source root |
| `build.also` | no | Further commands, run in order after the build |
| `manifest` | yes | Path to the Orivon manifest, relative to the app directory |
| `entry` | no | The HTML document inside `build.output`. Default `index.html` |
| `bridge.members` | no | The member declaration, relative to the app directory. The executor composes it into the served bridge — [`src/bridge/README.md`](../src/bridge/README.md) |
| `bridge.file` | no | The app's own bridge members. With `members`, it supplies the `hand` members and is spliced into the composed script; without it, it is a complete bridge script copied as it is. Required when any global declares a `hand` member |
| `extraFiles` | no | `[{ from, to }]` — `from` is relative to the source tree, `to` to the served tree |
| `hooks` | no | A `.mjs` file exporting `transformHtml(html, context)`, for HTML surgery the fields above cannot express |

An unknown field is an error, not something ignored: a typo in a field name is otherwise a
setting that silently does nothing.

## Tokens in commands

A command runs on a machine whose paths nobody can predict, so it names directories by token:

| Token | Expands to |
|---|---|
| `{recipe}` | `apps/<id>/` |
| `{source}` | `out/<id>/source/` |
| `{static}` | `out/<id>/static/` |

An unknown token is an error rather than a silent empty string — `rm -rf {oout}/x` expands to
`rm -rf /x` under a substitution that leaves unknowns alone.

## What `build` runs, and where

`install`, then `build.command`, then each of `build.also`, all with **the source tree as the
working directory**. That is the app's own tree, so its own `npx`, its own lockfile and its own
node_modules are what resolve.

After the build, the executor checks that `build.output/<entry>` exists. A build that reports
success and produces no entry document is the most common recipe mistake, and the error names
the path it looked for.

## An example

[`apps/freetube/recipe.json`](../apps/freetube/recipe.json) is the one real recipe. It wraps
upstream's own webpack config rather than forking it, which is why `build.command` names
`{recipe}`:

```json
{
  "id": "freetube",
  "name": "FreeTube",
  "port": 8875,
  "eth": "freetube.eth",
  "upstream": {
    "repo": "https://github.com/FreeTubeApp/FreeTube.git",
    "ref": "e910be68e49015a61af9d6de71632ae3bfc65ba0",
    "licence": "AGPL-3.0-or-later"
  },
  "install": "pnpm install --frozen-lockfile",
  "build": {
    "command": "npx webpack --config {recipe}/webpack.orivon.config.cjs",
    "output": "dist/orivon-electron-web",
    "also": ["pnpm run pack:botGuardScript"]
  },
  "manifest": "orivon.json",
  "bridge": { "members": "bridge/members.json", "file": "bridge/ft-electron.js" },
  "extraFiles": [{ "from": "dist/botGuardScript.js", "to": "orivon/botGuardScript.js" }]
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

## When the fields are not enough

`hooks` is the escape hatch, and it exists so the format does not have to grow a field for every
app's particular quirk. It exports one function:

```js
export function transformHtml (html, { recipe, dirs }) {
  return html.replace('</body>', '<iframe id="thing"></iframe></body>')
}
```

It runs **before** the manifest hint and the bridge script are injected, so those always end up
where they belong regardless of what a hook does. Make it idempotent: `prepare` may run twice.

No current port uses it. It is here because the alternative — an app that needs one line of HTML
surgery being blocked until someone changes `src/` — is worse than a seam with one test and no
user yet.

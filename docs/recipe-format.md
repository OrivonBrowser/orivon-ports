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
| `upstream.repo` | yes | An `https://` git URL |
| `upstream.ref` | yes | A **full 40-character commit sha**. A branch or tag makes the build unreproducible, so it is rejected |
| `upstream.licence` | yes | SPDX id, from the allowlist in `scripts/check-licences.ts`. A licence not on that list needs a person to decide, and adding it is that decision being recorded |
| `install` | no | Shell command run in the source tree before the build |
| `build.command` | yes | Shell command run in the source tree |
| `build.output` | yes | Where the build writes, relative to the source root |
| `build.also` | no | Further commands, run in order after the build |
| `manifest` | yes | Path to the Orivon manifest, relative to the app directory |
| `entry` | no | The HTML document inside `build.output`. Default `index.html` |
| `bridge.file` | no | The bridge script, relative to the app directory. Copied to `/orivon/<name>` and injected first in `<head>` |
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
  "bridge": { "file": "bridge/ft-electron-bridge.js" },
  "extraFiles": [{ "from": "dist/botGuardScript.js", "to": "orivon/botGuardScript.js" }]
}
```

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

# Contributing

The most useful contribution here is **a port of an app you actually use**.

## Before you start: is the app portable?

```bash
git clone --depth 1 <the app> ~/git/theirapp-src
npm install
node src/cli.ts recon ~/git/theirapp-src
```

Read the verdict. If the preload is a **generic forwarder**, the real surface is main's
`ipcMain` handler count, and a large one means an open-ended port — say so in the issue rather
than starting. If it is **named members**, multiply by roughly six lines each; that is the
bridge.

Open an issue with the recon output before writing code. It is five minutes, and it is the
difference between a port that lands and one that stalls half-finished.

## Making the port

```bash
node src/cli.ts new theirapp "Their App"
```

Then fill in `apps/theirapp/recipe.json`, write the bridge, and run it.
[`docs/porting-guide.md`](docs/porting-guide.md) is the method;
[`apps/freetube/`](apps/freetube/) is the worked example.

Three rules that are not negotiable, because the repository stops working without them:

1. **Never commit the app's source or its build output.** Both live in `out/`, which is
   gitignored. `npm run check:no-upstream` fails the build otherwise.
2. **Pin a commit, never a branch.** `npm run check:pinned`.
3. **Never edit the app's source.** If you think you must, re-read the escape test in the
   porting guide — you are either in the one case that genuinely requires it, or you have taken
   a shortcut that makes the port unrepeatable against the app's next release.

## Before you open a pull request

```bash
npm run typecheck && npm test && npm run check
node src/cli.ts run <your app>      # from an empty out/
```

Then **drive it in a real Orivon window and confirm the thing the app is for actually works**.
Metadata loading is not playback. The two most expensive bugs found in the FreeTube port both
produced a blank page with zero console errors.

Say in the pull request what you drove and what you saw.

## Code

- TypeScript, run directly by Node — no build step, so relative imports carry the `.ts`
  extension and nothing that needs code generation (`enum`, `namespace`, decorators) is allowed.
- No file over 500 lines, 800 for tests.
- Comments explain why, not what. Rationale that outgrows a few lines goes to the directory's
  `README.md` under `## Design notes`.
- A bridge is a classic script: no imports, no modules, and each app's own copy.

## Licence

By contributing you agree your contribution is licensed under AGPL-3.0-only, the same as the
rest of this repository.

# orivon-ports — agent operating instructions

**Read [`README.md`](README.md) first.** This file adds only what is specific to working here as
an agent.

| Read | Before |
|---|---|
| `README.md` | anything — what this repository is and what its commands do |
| `docs/porting-guide.md` | porting an app, or touching an `apps/<app>/bridge/` |
| `docs/recipe-format.md` | writing or changing a `recipe.json` |
| `.claude/skills/orivon-porting/` | the same method as a skill, with the traps |

This repository is the ports half of Orivon. The shell, the capability broker and the
`orivon.*` contracts live in `orivon-mvp`; a port is a consumer of that API, never part of it.

## The load-bearing rule

**A port is never a fork.** A recipe, a manifest, a build wrapper and one bridge file. The app's
source is cloned at a pinned commit into `out/<app>/source`, built there, and never committed.

If you find yourself editing the app's source, stop. You are either in the one case that
genuinely requires it — a value that escapes into app code, which `docs/porting-guide.md` calls
the escape test — or you have taken a shortcut that makes the port unrepeatable against the
app's next release.

## Rules

1. **Nothing of theirs is tracked.** No upstream source, no build output, no patches.
   `npm run check:no-upstream` is the guard, and it is an allowlist: a new kind of file in an
   app directory fails until someone adds its shape and says why.
2. **Pin a commit, never a branch.** `npm run check:pinned`.
3. **Pages say what is true now**, never who decided it or how it got there. No "used to", no
   "changed in", no PR numbers. Change history is git's job.
4. **Say which scope a sentence bounds** — this app, this repository, or Orivon. A reader cannot
   recover which you meant from context.
5. **Comments earn their place**, no source file over 500 lines (800 for tests), one
   implementation per idea. `npm run check:size`, `npm run check:comments`.
6. **Rationale goes to the directory README's Design notes**, not to a growing file header. The
   header budget is 25 leading comment lines, and the escape hatch declares itself:
   `// orivon:comment-budget -- <why>`.
7. **Each app stands alone.** Reproduce a pattern from a sibling port rather than importing it.
   Two ports sharing a file is two apps that break together. `src/` is the exception: whatever
   the executor covers, every future port gets free.
8. **Always prioritize Electron static files.** Compiling a site as web bundle goes against what Orivon wants to proof, and moreover, when static build is configured to webpack it may behave differently than Electron build instead
9. **Alert when orivon-mvp is a blocker**. Always report when an issue on porting an App, or on writing long code within apps/ folder, is caused by something missing from orivon-mvp side. Solution is never fixing it here, but handing a prompt to give to another AI what should be done on orivon-mvp and why.
10. You are allowed to use the orivon-mvp repo to run tests for porting apps
11. Always push to remote without confirmation when each work is done. Exception only for risky changes.

## This repository has no build step

Node runs the TypeScript directly (type stripping, 22.18+). Two consequences:

- **Relative imports carry the `.ts` extension** — `import { x } from './recipe.ts'`.
- **No TypeScript that needs code generation**: no `enum`, no `namespace`, no parameter
  properties, no decorators. Use string-literal unions and plain assignment.

`npm run doctor` probes this by running a real `.ts` file rather than comparing version strings.

## Verifying

```bash
npm run typecheck && npm test && npm run check
```

`npm test` includes `apps/**/*.test.ts`, so a bridge's tests run with everything else. There is
no `/tmp/vitest` workaround here and there should never need to be one.

**A gate that has never failed is not a gate.** When you add one, prove it fails on a real
violation before you commit it.

## What a change to a port must actually verify

Unit tests are not enough for a port, and metadata loading is not playback:

- `orivon-port test <app>` — every bridge member, including the inert and the refused ones.
- `orivon-port run <app>` from an empty `out/` — the clone, the build and the serve, in order.
- Then drive it in a real Orivon window and assert **the thing the app is for**. Both of the
  expensive traps in `apps/freetube/README.md` produced a blank page or a silent 404, not a
  stack trace. Run it, drive it, look at the window.

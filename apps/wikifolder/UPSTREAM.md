# Upstream: TiddlyWiki

| | |
|---|---|
| Source | `https://github.com/TiddlyWiki/TiddlyWiki5` |
| Pinned commit | `d391595836e2aead565480763f9bf9eb52e29e75` (v5.4.1) |
| Licence | BSD-3-Clause (the file `license` at the top of the repository) |

## What crosses into this repository

**Nothing of TiddlyWiki's.** The clone lives in `out/wikifolder/source/` and everything built from
it in `out/wikifolder/static/`, both gitignored and both reproducible from
[`recipe.json`](recipe.json). `npm run check:no-upstream` fails the build if either is ever
tracked.

What is ours, and written from scratch:

- [`recipe.json`](recipe.json) and [`orivon.json`](orivon.json).
- [`esbuild.orivon.config.mjs`](esbuild.orivon.config.mjs), which runs in the clone after the
  recipe's install step, collects the files the server reads into one pack, and bundles the port's
  own server entry and launcher. [`bridge/`](bridge/) holds what the build decides
  (`install-plan.js`, with its test), the server bundle's entry (`server-entry.js`), and the stand-in
  for two `vm` calls (`vm-stand-in.js`, with its test). None holds a line of upstream's code.
- [`launcher/`](launcher/), the page that unpacks the install tree, makes the wiki folder and
  starts the server, and shows what it serves. It is written here and is not derived from
  TiddlyWiki's pages, which the server renders as upstream wrote them. It is a shape of file
  `scripts/app-files.ts` admits only under `apps/<id>/launcher/`: hand-written `.html`, `.css`,
  `.js` and `.svg`, plus its unit tests.

## What we never do

- **Edit TiddlyWiki's source.** The clone on disk is never edited, and the files the server reads
  are upstream's, byte for byte: the build copies them into the pack and nothing rewrites a
  character. The server that runs is upstream's boot kernel, loaded from them.
- **Fork its build.** TiddlyWiki has no build: the kernel loads the core, the plugins and the
  editions from the directories it ships in. The port's step reads them and adds nothing to them.

## What the port adds around the kernel

Two `vm` calls the shim refuses by name, `createContext` and `runInContext`, are answered by a
stand-in that runs the kernel's module text in the Worker's own realm (`bridge/vm-stand-in.js`). It
is applied to the shim's `vm` object at run time, in the Worker, before the kernel loads. The build
reads `boot/boot.js` and fails when it calls another `vm` member, or no longer reads its
global-assignment check through `__temp__`: both mean the stand-in must be looked at again when the
pin moves.

## Redistribution

This repository distributes none of TiddlyWiki. The tree a build produces does: upstream's kernel,
core, plugins, themes, languages and two editions (BSD-3-Clause, with the licences their own files
state), orivon-mvp's Node shim (AGPL-3.0) and upstream's `license`, copied to `/LICENSE` in the
served tree. A build served to other people is therefore a conveyed AGPL work as a whole, with
TiddlyWiki's BSD notice travelling with its part.

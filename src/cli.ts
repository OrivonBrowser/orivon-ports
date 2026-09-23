#!/usr/bin/env node
import { access } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { spawn } from 'node:child_process'
import type { Server } from 'node:http'
import { listAppIds, loadAllRecipes, loadRecipe } from './apps.ts'
import { buildApp } from './build.ts'
import { fetchApp } from './fetch.ts'
import { formatChecks, runDoctor } from './doctor.ts'
import { acquireLock } from './lock.ts'
import { dirsFor, outAppDir, OUT_DIR, recipeDir, REPO_ROOT, staticDir } from './paths.ts'
import { NAMES_JSON, NAMES_PAC, writeNamesFiles } from './names.ts'
import { prepareApp } from './prepare.ts'
import { formatRecon, recon, writeDeclaration } from './recon.ts'
import { scaffold } from './scaffold.ts'
import { readState } from './state.ts'
import { HOST, startServer } from './serve.ts'
import { isSite } from './recipe.ts'
import type { Recipe } from './recipe.ts'

const HELP = `orivon-port -- build and serve ported apps

  run <app>          fetch, build and serve it  (the one command)
  fetch <app>        clone upstream at the pinned commit
  build <app>        run the app's own build, then prepare the static tree
  serve <app>...     serve already-built apps, each on its own port   (--all for every app)
                     (rewrites the names files from every recipe first)
  test <app>         run the app's bridge tests
  list               what exists, what is fetched, what is built
  new <app> [name]   scaffold a new port
  recon <clone>      measure somebody's app before committing to porting it
  names              write out/orivon-names.pac and out/names.json for every app.eth
  doctor             check this machine can build and serve

Options
  --force            re-fetch even if the pinned commit is already checked out
  --rebuild          rebuild even if the current commit was already built
  --port <n>         serve one app on this port instead of its recipe's
  --emit <app>       recon only: write its member list into apps/<app>/bridge/members.json
  --global <name>    recon only: emit just this exposeInMainWorld name, not every one
`

async function exists (path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false)
}

function flag (argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`)
}

function option (argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

/**
 * The non-flag arguments. `--port` is the one flag that takes a value, so its
 * value is skipped rather than mistaken for an app id; every other flag is
 * boolean and simply skipped. The command itself is never in the list --
 * callers hand it `argv.slice(1)`.
 */
function positionals (argv: readonly string[]): string[] {
  const values: string[] = []
  let skipValue = false
  for (const arg of argv) {
    if (skipValue) { skipValue = false; continue }
    if (arg === '--port') { skipValue = true; continue }
    if (arg.startsWith('--')) continue
    values.push(arg)
  }
  return values
}

async function ensureBuilt (recipe: Recipe, argv: readonly string[]): Promise<void> {
  const release = await acquireLock(outAppDir(recipe.id), recipe.id)
  try {
    const dirs = dirsFor(recipe.id)
    // A site is a copy of files in this repository, so it is prepared every
    // time: there is no ref to compare, and a stale tree is the one failure.
    if (isSite(recipe)) {
      process.stdout.write(`[${recipe.id}] prepared at ${await prepareApp(recipe, dirs)}\n`)
      return
    }
    await fetchApp(recipe, dirs, { force: flag(argv, 'force') })

    const state = await readState(outAppDir(recipe.id))
    const fresh = state.builtFromRef === recipe.upstream.ref && await exists(join(staticDir(recipe.id), recipe.entry))
    if (fresh && !flag(argv, 'rebuild')) {
      process.stdout.write(`[${recipe.id}] already built from ${recipe.upstream.ref.slice(0, 8)} -- --rebuild to redo it\n`)
      return
    }

    await buildApp(recipe, dirs)
    process.stdout.write(`[${recipe.id}] prepared at ${await prepareApp(recipe, dirs)}\n`)
  } finally {
    await release()
  }
}

async function serveOne (recipe: Recipe, port: number): Promise<Server> {
  const root = staticDir(recipe.id)
  if (!await exists(join(root, recipe.entry))) {
    throw new Error(`[${recipe.id}] nothing built yet -- run \`orivon-port run ${recipe.id}\` first`)
  }
  return startServer({ root, port, label: recipe.id, entry: recipe.entry, ...(recipe.eth === undefined ? {} : { name: recipe.eth }) })
}

function holdOpen (servers: readonly Server[]): void {
  const shutdown = (): void => {
    for (const server of servers) server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/**
 * The names files, rewritten by every command about to start servers. The
 * explicit `names` command stays, but relying on it alone is how the map the
 * shell reads went stale: a name or port that changed since its last run
 * resolved to nothing while every name declared before it kept working, and
 * nothing pointed at the discrepancy. The rewrite is never fatal -- the
 * servers work at their loopback ports with no map at all, and the shell's
 * eth-resolver reports a map it cannot use on its own -- so a failure here is
 * said once, loudly, and the servers come up anyway.
 */
async function rewriteNames (): Promise<void> {
  try {
    const apps = await writeNamesFiles(OUT_DIR, await loadAllRecipes())
    if (apps.length === 0) return
    process.stdout.write(`[names] ${relative(REPO_ROOT, join(OUT_DIR, NAMES_JSON))}: ${apps.map((app) => app.name).join(', ')}\n`)
  } catch (error) {
    process.stderr.write(`[orivon-port] could not rewrite the names files (${NAMES_JSON}, ${NAMES_PAC}): ${error instanceof Error ? error.message : String(error)}\nthe servers are starting anyway; \`orivon-port names\` shows the error again\n`)
  }
}

/**
 * `serve`'s whole surface: one app, a list of apps, or every app. A listed
 * app is served on the port its recipe declares -- one origin per app means
 * the port is part of the app's identity (src/README.md), so `--port`, which
 * moves one, only makes sense for a single app.
 */
async function serveListed (argv: readonly string[]): Promise<void> {
  if (flag(argv, 'all')) {
    const recipes = await loadAllRecipes()
    if (recipes.length === 0) throw new Error('no apps yet -- `orivon-port new <id>` makes one')
    await rewriteNames()
    holdOpen(await Promise.all(recipes.map((recipe) => serveOne(recipe, recipe.port))))
    return
  }
  const ids = [...new Set(positionals(argv.slice(1)))]
  if (ids.length === 0) {
    const known = await listAppIds()
    throw new Error(`serve needs at least one app id -- known apps: ${known.join(', ') || 'none yet'} (--all for every app)`)
  }
  const port = option(argv, 'port')
  if (port !== undefined && ids.length > 1) {
    throw new Error('--port serves a single app; a list of apps serves each on the port its recipe declares')
  }
  const recipes = await Promise.all(ids.map(loadRecipe))
  await rewriteNames()
  holdOpen(await Promise.all(recipes.map((recipe) => serveOne(recipe, Number(port ?? recipe.port)))))
}

async function listApps (): Promise<void> {
  const recipes = await loadAllRecipes()
  if (recipes.length === 0) { process.stdout.write('no apps yet -- `orivon-port new <id>` makes one\n'); return }
  for (const recipe of recipes) {
    const name = recipe.eth === undefined ? '' : ` (${recipe.eth}, via \`orivon-port names\`)`
    const url = `http://${HOST}:${String(recipe.port)}${name}`
    if (isSite(recipe)) {
      const prepared = await exists(join(staticDir(recipe.id), recipe.entry)) ? 'prepared' : 'not prepared'
      process.stdout.write(`${recipe.id.padEnd(16)} ${'site'.padEnd(8)}  ${'written here'.padEnd(12)} ${prepared.padEnd(26)} ${url}\n`)
      continue
    }
    const state = await readState(outAppDir(recipe.id))
    const built = state.builtFromRef === recipe.upstream.ref ? 'built' : (state.builtFromRef === undefined ? 'not built' : 'built from an older commit')
    const fetched = state.fetchedRef === recipe.upstream.ref ? 'fetched' : 'not fetched'
    process.stdout.write(`${recipe.id.padEnd(16)} ${recipe.upstream.ref.slice(0, 8)}  ${fetched.padEnd(12)} ${built.padEnd(26)} ${url}\n`)
  }
}

async function emitNames (): Promise<void> {
  const apps = await writeNamesFiles(OUT_DIR, await loadAllRecipes())
  const pacPath = join(OUT_DIR, NAMES_PAC)
  const jsonPath = join(OUT_DIR, NAMES_JSON)
  if (apps.length === 0) {
    process.stdout.write(`no app declares an "eth" name -- wrote an empty ${relative(REPO_ROOT, pacPath)} anyway\n`)
    return
  }
  process.stdout.write(`wrote ${relative(REPO_ROOT, pacPath)} and ${relative(REPO_ROOT, jsonPath)}:\n`)
  for (const app of apps) process.stdout.write(`  ${app.name.padEnd(20)} -> http://${HOST}:${String(app.port)}\n`)
  process.stdout.write(`
This resolves nothing by itself -- the shell has to be launched with this file's path in an
environment variable, every time (serve and run rewrite the file, but the shell reads it once,
at its own startup):

  ORIVON_ETH_NAMES_FILE=${jsonPath} npm run dev

(run from orivon-mvp's own checkout; \`npm run dev\` already sets ORIVON_DEV_ORIGINS=1 -- \`npm start\`
does not, and needs it set alongside this one). Without it, a name above is not distinguishable
from any other unregistered address.\n`)
}

async function runTests (id: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npx', ['vitest', 'run', `apps/${id}`], { cwd: REPO_ROOT, stdio: 'inherit', shell: true })
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tests failed (exit ${String(code)})`))
    })
  })
}

async function main (argv: readonly string[]): Promise<void> {
  const [command, target] = argv

  switch (command) {
    case 'doctor': {
      const checks = await runDoctor()
      process.stdout.write(`${formatChecks(checks)}\n`)
      if (checks.some((check) => check.level === 'fail')) process.exitCode = 1
      return
    }
    case 'list': return listApps()
    case 'names': return emitNames()
    case 'serve': return serveListed(argv)
    case 'recon': {
      if (target === undefined) throw new Error('recon needs a path to a clone of the app you are considering')
      const report = await recon(target)
      process.stdout.write(`${formatRecon(report, target)}\n`)
      const emit = option(argv, 'emit')
      if (emit !== undefined) {
        if (!(await listAppIds()).includes(emit)) {
          throw new Error(`no app "${emit}" yet -- \`orivon-port new ${emit}\` first, then re-run with --emit ${emit}`)
        }
        const path = join(recipeDir(emit), 'bridge', 'members.json')
        const kept = await writeDeclaration(path, report, option(argv, 'global'))
        process.stdout.write(`\nwrote ${relative(REPO_ROOT, path)}: every new member unclassified, and the build refuses until each one is bucketed\n`)
        if (kept.length > 0) process.stdout.write(`  left as it was, already bucketed: ${kept.join(', ')}\n`)
      }
      return
    }
    case 'new': {
      if (target === undefined) throw new Error('new needs an app id, e.g. `orivon-port new joplin "Joplin"`')
      process.stdout.write(`scaffolded ${await scaffold(target, argv[2])}\n  edit recipe.json: upstream.repo, upstream.ref and the build commands\n`)
      return
    }
    default: break
  }

  if (target === undefined) {
    throw new Error(`${String(command)} needs an app id -- known apps: ${(await listAppIds()).join(', ') || 'none yet'}`)
  }
  const recipe = await loadRecipe(target)
  const port = Number(option(argv, 'port') ?? recipe.port)

  switch (command) {
    case 'fetch': {
      if (isSite(recipe)) throw new Error(`[${recipe.id}] is written here, in apps/${recipe.id}/${recipe.site} -- there is nothing to fetch`)
      return fetchApp(recipe, dirsFor(recipe.id), { force: flag(argv, 'force') })
    }
    case 'build': return ensureBuilt(recipe, argv)
    case 'test': return runTests(recipe.id)
    case 'run': {
      await ensureBuilt(recipe, argv)
      await rewriteNames()
      holdOpen([await serveOne(recipe, port)])
      return
    }
    default:
      throw new Error(`unknown command "${String(command)}"\n\n${HELP}`)
  }
}

const argv = process.argv.slice(2)

if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  process.stdout.write(HELP)
} else {
  try {
    await main(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

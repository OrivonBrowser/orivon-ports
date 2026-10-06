#!/usr/bin/env node
import { access } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import type { Server } from 'node:http'
import { listAppIds, loadAllRecipes, loadRecipe } from './apps.ts'
import { buildApp } from './build.ts'
import { DDOC, declareBundle } from './declare.ts'
import { fetchApp } from './fetch.ts'
import { formatChecks, runDoctor } from './doctor.ts'
import { acquireLock } from './lock.ts'
import { dirsFor, outAppDir, OUT_DIR, recipeDir, REPO_ROOT, staticDir } from './paths.ts'
import { NAMES_JSON, NAMES_PAC, writeNamesFiles } from './names.ts'
import { prepareApp } from './prepare.ts'
import { formatRecon, recon, writeDeclaration } from './recon.ts'
import { scaffold } from './scaffold.ts'
import { readState, recipeDigest, staleBuildNotice, stalePrepareNotice, writeState } from './state.ts'
import { HOST, startServer } from './serve.ts'
import { isSite } from './recipe.ts'
import type { Recipe, RecipeDirs } from './recipe.ts'
import { eachApp, flag, option, positionals, selectApps } from './selection.ts'

const HELP = `orivon-port -- build and serve ported apps

  run <app>...       fetch, build and serve them  (the one command)
  fetch <app>...     clone upstream at the pinned commit
  build <app>...     run each app's own build, then prepare its static tree
  serve <app>...     serve already-built apps, each on its own port
                     (run and serve rewrite the names files from every recipe first)
  test <app>...      run the apps' bridge tests
  list               what exists, what is fetched, what is built
  new <app> [name]   scaffold a new port
  recon <clone>      measure somebody's app before committing to porting it
  names              write out/orivon-names.pac and out/names.json for every app.eth
  hash <dir>         declare a prepared tree: its manifest's assets and its bundle hash
                     (--check: change nothing, fail if either is stale)
  doctor             check this machine can build and serve

run, fetch, build, serve and test take one app, several, or --all. Several are done one at
a time, past any that fails, and the failures are named again at the end.

Options
  --all              every app, instead of naming them
  --force            re-fetch even if the pinned commit is already checked out
  --rebuild          rebuild even if the current commit was already built
  --no-orivon-hint   build/run: leave out the panel that asks visitors in other browsers
                     to open the app in Orivon (re-prepares a built tree, never rebuilds it)
  --port <n>         run/serve: one app on this port instead of its recipe's
  --emit <app>       recon only: write its member list into apps/<app>/bridge/members.json
  --global <name>    recon only: emit just this exposeInMainWorld name, not every one
`

/** The commands that act on apps: each takes one or more ids, or --all. */
const APP_COMMANDS = new Set(['run', 'fetch', 'build', 'serve', 'test'])

async function exists (path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false)
}

async function prepare (recipe: Recipe, dirs: RecipeDirs, orivonHint: boolean): Promise<void> {
  const preparedFrom = await recipeDigest(dirs.recipe)
  const out = await prepareApp(recipe, dirs, { orivonHint })
  if (!isSite(recipe)) await writeState(outAppDir(recipe.id), { orivonHint, preparedFrom })
  process.stdout.write(`[${recipe.id}] prepared at ${out}${orivonHint ? '' : ', without the Orivon hint'}\n`)
}

async function ensureBuilt (recipe: Recipe, argv: readonly string[]): Promise<void> {
  const release = await acquireLock(outAppDir(recipe.id), recipe.id)
  try {
    const dirs = dirsFor(recipe.id)
    const orivonHint = !flag(argv, 'no-orivon-hint')
    // A site is a copy of files in this repository, so it is prepared every
    // time: there is no ref to compare, and a stale tree is the one failure.
    if (isSite(recipe)) {
      await prepare(recipe, dirs, orivonHint)
      return
    }
    await fetchApp(recipe, dirs, { force: flag(argv, 'force') })

    const state = await readState(outAppDir(recipe.id))
    const fresh = state.builtFromRef === recipe.upstream.ref && await exists(join(staticDir(recipe.id), recipe.entry))
    const reuse = fresh && !flag(argv, 'rebuild')
    const recipeChanged = state.preparedFrom !== await recipeDigest(dirs.recipe)
    if (reuse && state.orivonHint === orivonHint && !recipeChanged) {
      process.stdout.write(`[${recipe.id}] already built from ${recipe.upstream.ref.slice(0, 8)} -- --rebuild to redo it\n`)
      // A fresh tree with no ddoc file is declared, not rebuilt: declaring
      // costs one walk, rebuilding costs the app's whole toolchain.
      if (!await exists(join(staticDir(recipe.id), DDOC))) {
        const declared = await declareBundle(staticDir(recipe.id), { check: false, label: recipe.id })
        process.stdout.write(`[${recipe.id}] declared ${declared.bundleHash}\n`)
      }
      return
    }
    // Preparing is a copy, rebuilding is the app's whole toolchain: a fresh
    // build whose tree has the hint the other way round, or was prepared from
    // a recipe directory since edited, is prepared again from what the clone
    // still holds, when it holds every file prepare reads.
    const inputs = [recipe.build.output, ...recipe.extraFiles.map((extra) => extra.from)]
    if (reuse && (await Promise.all(inputs.map((input) => exists(join(dirs.source, input))))).every(Boolean)) {
      const why = recipeChanged ? `apps/${recipe.id}/ changed since it was prepared` : `${orivonHint ? 'with' : 'without'} the Orivon hint`
      process.stdout.write(`[${recipe.id}] already built from ${recipe.upstream.ref.slice(0, 8)} -- preparing it again: ${why}\n`)
      await prepare(recipe, dirs, orivonHint)
      return
    }

    await buildApp(recipe, dirs)
    await prepare(recipe, dirs, orivonHint)
  } finally {
    await release()
  }
}

async function serveOne (recipe: Recipe, port: number): Promise<Server> {
  const root = staticDir(recipe.id)
  if (!await exists(join(root, recipe.entry))) {
    throw new Error(`[${recipe.id}] nothing built yet -- run \`orivon-port run ${recipe.id}\` first`)
  }
  // `serve` never rebuilds. Refusing would also stop every other app in the
  // same command, so a stale build is served and said so.
  if (!isSite(recipe)) {
    const state = await readState(outAppDir(recipe.id))
    const notices = [staleBuildNotice(recipe.id, state, recipe.upstream.ref), stalePrepareNotice(recipe.id, state, await recipeDigest(recipeDir(recipe.id)))]
    for (const notice of notices) if (notice !== undefined) process.stderr.write(`${notice}\n`)
  }
  return startServer({ root, port, label: recipe.id, entry: recipe.entry, ...(recipe.eth === undefined ? {} : { name: recipe.eth }) })
}

function holdOpen (servers: readonly Server[]): void {
  const shutdown = (): void => {
    for (const server of servers) server.close()
    // An app that failed to build or start set the exit code; stopping keeps it.
    process.exit()
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
 * The apps a command names, loaded before any work starts, so a mistyped id
 * fails in a second rather than after the builds listed before it.
 */
async function selectRecipes (argv: readonly string[]): Promise<Recipe[]> {
  return Promise.all(selectApps(argv, await listAppIds()).map(loadRecipe))
}

function say (line: string): void {
  process.stderr.write(`${line}\n`)
}

/** `work` for each app; an app that failed sets the exit code, but only every app failing stops the command. */
async function forEachApp (recipes: readonly Recipe[], work: (recipe: Recipe) => Promise<unknown>): Promise<Recipe[]> {
  const done = await eachApp(recipes, work, say)
  if (done.length < recipes.length) process.exitCode = 1
  return done
}

/**
 * Serves each app on the port its recipe declares, or one app on `--port`.
 * An app that cannot start (nothing built, its port taken) never stops the
 * others.
 */
async function serveAll (recipes: readonly Recipe[], argv: readonly string[]): Promise<void> {
  const port = option(argv, 'port')
  await rewriteNames()
  const servers: Server[] = []
  await forEachApp(recipes, async (recipe) => { servers.push(await serveOne(recipe, Number(port ?? recipe.port))) })
  holdOpen(servers)
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

async function runTests (ids: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npx', ['vitest', 'run', ...ids.map((id) => `apps/${id}`)], { cwd: REPO_ROOT, stdio: 'inherit', shell: true })
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
    case 'hash': {
      const [dir] = positionals(argv.slice(1))
      if (dir === undefined) throw new Error('hash needs a prepared static tree, e.g. `orivon-port hash out/freetube/static`')
      const check = flag(argv, 'check')
      const declared = await declareBundle(resolve(dir), { check, label: dir })
      process.stdout.write(`[${dir}] ${check ? 'matches' : 'declared'} ${declared.bundleHash}: ${String(declared.files)} files, manifest ${String(declared.manifestBytes)} bytes\n`)
      return
    }
    case 'new': {
      if (target === undefined) throw new Error('new needs an app id, e.g. `orivon-port new joplin "Joplin"`')
      process.stdout.write(`scaffolded ${await scaffold(target, argv[2])}\n  edit recipe.json: upstream.repo, upstream.ref and the build commands, and orivon.json's domain\n`)
      return
    }
    default: break
  }

  if (command === undefined || !APP_COMMANDS.has(command)) {
    throw new Error(`unknown command "${String(command)}"\n\n${HELP}`)
  }
  const recipes = await selectRecipes(argv)

  switch (command) {
    case 'fetch': {
      await forEachApp(recipes, async (recipe) => {
        if (!isSite(recipe)) return fetchApp(recipe, dirsFor(recipe.id), { force: flag(argv, 'force') })
        // --all names sites too; one named on purpose is a mistake to report.
        if (!flag(argv, 'all')) throw new Error(`[${recipe.id}] is written here, in apps/${recipe.id}/${recipe.site} -- there is nothing to fetch`)
        process.stdout.write(`[${recipe.id}] written here -- nothing to fetch\n`)
      })
      return
    }
    case 'build': {
      await forEachApp(recipes, (recipe) => ensureBuilt(recipe, argv))
      return
    }
    case 'test': return runTests(recipes.map((recipe) => recipe.id))
    case 'run': return serveAll(await forEachApp(recipes, (recipe) => ensureBuilt(recipe, argv)), argv)
    case 'serve': return serveAll(recipes, argv)
    default: throw new Error(`unknown command "${command}"`)
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

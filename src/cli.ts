#!/usr/bin/env node
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { Server } from 'node:http'
import { listAppIds, loadAllRecipes, loadRecipe } from './apps.ts'
import { buildApp } from './build.ts'
import { fetchApp } from './fetch.ts'
import { formatChecks, runDoctor } from './doctor.ts'
import { acquireLock } from './lock.ts'
import { dirsFor, outAppDir, REPO_ROOT, staticDir } from './paths.ts'
import { prepareApp } from './prepare.ts'
import { formatRecon, recon } from './recon.ts'
import { scaffold } from './scaffold.ts'
import { readState } from './state.ts'
import { HOST, startServer } from './serve.ts'
import type { Recipe } from './recipe.ts'

const HELP = `orivon-port -- build and serve ported apps

  run <app>          fetch, build and serve it  (the one command)
  fetch <app>        clone upstream at the pinned commit
  build <app>        run the app's own build, then prepare the static tree
  serve <app>        serve an already-built app   (--all for every app)
  test <app>         run the app's bridge tests
  list               what exists, what is fetched, what is built
  new <app> [name]   scaffold a new port
  recon <clone>      measure somebody's app before committing to porting it
  doctor             check this machine can build and serve

Options
  --force            re-fetch even if the pinned commit is already checked out
  --rebuild          rebuild even if the current commit was already built
  --port <n>         serve on this port instead of the recipe's
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

async function ensureBuilt (recipe: Recipe, argv: readonly string[]): Promise<void> {
  const release = await acquireLock(outAppDir(recipe.id), recipe.id)
  try {
    const dirs = dirsFor(recipe.id)
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
  return startServer({ root, port, label: recipe.id, entry: recipe.entry })
}

function holdOpen (servers: readonly Server[]): void {
  const shutdown = (): void => {
    for (const server of servers) server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function listApps (): Promise<void> {
  const recipes = await loadAllRecipes()
  if (recipes.length === 0) { process.stdout.write('no apps yet -- `orivon-port new <id>` makes one\n'); return }
  for (const recipe of recipes) {
    const state = await readState(outAppDir(recipe.id))
    const built = state.builtFromRef === recipe.upstream.ref ? 'built' : (state.builtFromRef === undefined ? 'not built' : 'built from an older commit')
    const fetched = state.fetchedRef === recipe.upstream.ref ? 'fetched' : 'not fetched'
    process.stdout.write(`${recipe.id.padEnd(16)} ${recipe.upstream.ref.slice(0, 8)}  ${fetched.padEnd(12)} ${built.padEnd(26)} http://${HOST}:${String(recipe.port)}\n`)
  }
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
    case 'recon': {
      if (target === undefined) throw new Error('recon needs a path to a clone of the app you are considering')
      process.stdout.write(`${formatRecon(await recon(target), target)}\n`)
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
    case 'fetch': return fetchApp(recipe, dirsFor(recipe.id), { force: flag(argv, 'force') })
    case 'build': return ensureBuilt(recipe, argv)
    case 'test': return runTests(recipe.id)
    case 'serve': {
      holdOpen([await serveOne(recipe, port)])
      return
    }
    case 'run': {
      await ensureBuilt(recipe, argv)
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
} else if (argv[0] === 'serve' && flag(argv, 'all')) {
  const recipes = await loadAllRecipes()
  holdOpen(await Promise.all(recipes.map(async (recipe) => serveOne(recipe, recipe.port))))
} else {
  try {
    await main(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

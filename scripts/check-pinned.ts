// Every recipe pins a commit, and no two apps share an origin.
//
// A branch or tag makes a build unreproducible: the same recipe produces a
// different app tomorrow. Two apps on one port share an origin, and a grant
// attaches to the origin -- so one app would inherit the other's permissions.
import { loadAllRecipes } from '../src/apps.ts'
import { report } from './lib.ts'

const FULL_SHA = /^[0-9a-f]{40}$/

const problems: string[] = []
const ports = new Map<number, string>()

for (const recipe of await loadAllRecipes()) {
  if (!FULL_SHA.test(recipe.upstream.ref)) {
    problems.push(`apps/${recipe.id}: upstream.ref "${recipe.upstream.ref}" is not a full commit sha`)
  }
  const owner = ports.get(recipe.port)
  if (owner !== undefined) {
    problems.push(`apps/${recipe.id} and apps/${owner} both claim port ${String(recipe.port)} -- one origin per app, because a grant attaches to the origin`)
  }
  ports.set(recipe.port, recipe.id)
}

report('check:pinned', problems)

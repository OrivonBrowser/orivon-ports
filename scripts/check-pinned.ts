// Every recipe parses, pins a commit, and owns its own origin.
//
// The pin itself is enforced by the recipe schema, which rejects anything
// that is not a full commit sha -- loading every recipe here is what applies
// it repository-wide. What only a whole-repository view can see is the pair
// of clashes below: two apps on one port share an origin, and a grant
// attaches to the origin, so one app would inherit the other's permissions.
import { recipesOrReport, report } from './lib.ts'

const problems: string[] = []
const ports = new Map<number, string>()

for (const recipe of await recipesOrReport('check:pinned')) {
  const owner = ports.get(recipe.port)
  if (owner !== undefined) {
    problems.push(`apps/${recipe.id} and apps/${owner} both claim port ${String(recipe.port)} -- one origin per app, because a grant attaches to the origin`)
  }
  ports.set(recipe.port, recipe.id)
}

report('check:pinned', problems)

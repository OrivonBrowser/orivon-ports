import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listAppIds, loadAllRecipes } from './apps.ts'
import { recipeDir } from './paths.ts'

const TEMPLATES = fileURLToPath(new URL('templates/', import.meta.url))
const FIRST_PORT = 8875

export interface ScaffoldPlan {
  readonly id: string
  readonly name: string
  readonly bridgeName: string
  readonly port: number
  readonly eth: string
}

/**
 * One origin per app, and the origin is the permission boundary: a grant
 * attaches to the URL, so two apps sharing a port would share a grant. The
 * port is therefore allocated once, written into the recipe, and never
 * derived at runtime -- a port that moved would silently drop the grant.
 */
export async function nextFreePort (): Promise<number> {
  const taken = new Set((await loadAllRecipes()).map((recipe) => recipe.port))
  let port = FIRST_PORT
  while (taken.has(port)) port += 1
  return port
}

export function toBridgeName (id: string): string {
  const camel = id.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
  return `${camel}Api`
}

export function fill (template: string, plan: ScaffoldPlan): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const values: Record<string, string> = {
      id: plan.id,
      name: plan.name,
      bridgeName: plan.bridgeName,
      port: String(plan.port),
      eth: plan.eth
    }
    const value = values[key]
    if (value === undefined) throw new Error(`template uses unknown placeholder {{${key}}}`)
    return value
  })
}

async function emit (template: string, target: string, plan: ScaffoldPlan): Promise<void> {
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, fill(await readFile(join(TEMPLATES, template), 'utf8'), plan))
}

export async function scaffold (id: string, name?: string): Promise<string> {
  const dir = recipeDir(id)
  if (await access(dir).then(() => true).catch(() => false)) {
    throw new Error(`apps/${id}/ already exists -- pick another id, or edit it. Known apps: ${(await listAppIds()).join(', ')}`)
  }

  const plan: ScaffoldPlan = { id, name: name ?? id, bridgeName: toBridgeName(id), port: await nextFreePort(), eth: `${id}.eth` }
  await mkdir(join(dir, 'bridge'), { recursive: true })
  await emit('recipe.json.tmpl', join(dir, 'recipe.json'), plan)
  await emit('orivon.json.tmpl', join(dir, 'orivon.json'), plan)
  await emit('README.md.tmpl', join(dir, 'README.md'), plan)
  await emit('UPSTREAM.md.tmpl', join(dir, 'UPSTREAM.md'), plan)
  await emit('members.json.tmpl', join(dir, 'bridge', 'members.json'), plan)
  await emit('bridge.js.tmpl', join(dir, 'bridge', `${id}.js`), plan)
  await emit('bridge.test.ts.tmpl', join(dir, 'bridge', `${id}.test.ts`), plan)
  return dir
}

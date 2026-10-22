import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadAllRecipes } from '../apps.ts'
import { isSite } from '../recipe.ts'

const FORM = readFileSync(join(import.meta.dirname, '..', '..', '.github', 'ISSUE_TEMPLATE', 'port-problem.yml'), 'utf8')
const recipes = await loadAllRecipes()

/** The `app` dropdown's option labels, which are what the hint's report link prefills. */
function formApps (): string[] {
  const block = /- type: dropdown\n\s+id: app\n[\s\S]*?options:\n((?:\s+- .*\n)+)/.exec(FORM)
  if (block?.[1] === undefined) throw new Error('port-problem.yml has no "app" dropdown')
  return [...block[1].matchAll(/^\s+- (.*)$/gm)].map((match) => match[1] as string)
}

describe('every app\'s hint', () => {
  it('is decided: each recipe has one', () => {
    expect(recipes.filter((recipe) => recipe.hint === undefined).map((recipe) => recipe.id)).toEqual([])
  })

  it('names an official download for a port and none for an app written here, a site or one built on a library', () => {
    for (const recipe of recipes) {
      const writtenHere = isSite(recipe) || recipe.upstream.library === true
      expect(recipe.hint?.officialUrl !== undefined, recipe.id).toBe(!writtenHere)
    }
  })

  it('has a name the issue form lists, and the form lists no other', () => {
    expect(formApps().sort()).toEqual(recipes.map((recipe) => recipe.hint?.name as string).sort())
  })

  it('has a name that is the recipe\'s own for a port, so "not the official <name>" names the right app', () => {
    for (const recipe of recipes.filter((one) => !isSite(one))) expect(recipe.hint?.name, recipe.id).toBe(recipe.name)
  })

  it('needs a .eth name when it is tier 2, because the Open in Orivon link is built from it', () => {
    for (const recipe of recipes.filter((one) => one.hint?.tier === 2)) expect(recipe.eth, recipe.id).toMatch(/\.eth$/)
  })

  it('says nothing the wording rules forbid', () => {
    for (const recipe of recipes) {
      const words = [recipe.hint?.text, recipe.hint?.notice].join(' ')
      expect(words, recipe.id).not.toMatch(/unsupported|permissionless|\bfork\b|anonym|private|coming soon|\bofficial\b/i)
    }
  })
})

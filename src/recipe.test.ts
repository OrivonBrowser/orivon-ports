import { describe, expect, it } from 'vitest'
import { parseRecipe, expandTokens, RecipeError } from './recipe.ts'

const VALID = {
  id: 'freetube',
  name: 'FreeTube',
  port: 8875,
  upstream: {
    repo: 'https://github.com/FreeTubeApp/FreeTube.git',
    ref: 'e910be68e49015a61af9d6de71632ae3bfc65ba0',
    licence: 'AGPL-3.0-or-later'
  },
  build: { command: 'npx webpack', output: 'dist/orivon-electron-web' },
  manifest: 'orivon.json'
}

const withField = (path: string, value: unknown): unknown => {
  const copy = structuredClone(VALID) as Record<string, unknown>
  const parts = path.split('.')
  let cursor = copy
  for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string, unknown>
  const last = parts[parts.length - 1] as string
  if (value === undefined) delete cursor[last]
  else cursor[last] = value
  return copy
}

describe('parseRecipe', () => {
  it('accepts a minimal valid recipe', () => {
    const recipe = parseRecipe(VALID, 'apps/freetube/recipe.json')
    expect(recipe.id).toBe('freetube')
    expect(recipe.upstream.ref).toBe('e910be68e49015a61af9d6de71632ae3bfc65ba0')
  })

  // Every failure names the field. A recipe is the one file a newcomer writes
  // by hand, and "invalid recipe" with no field name is what makes them give up.
  it.each([
    ['id', undefined],
    ['name', undefined],
    ['port', undefined],
    ['upstream', undefined],
    ['upstream.repo', undefined],
    ['upstream.ref', undefined],
    ['upstream.licence', undefined],
    ['build', undefined],
    ['build.command', undefined],
    ['build.output', undefined],
    ['manifest', undefined]
  ])('names the field when %s is missing', (path) => {
    expect(() => parseRecipe(withField(path, undefined), 'r.json')).toThrow(RecipeError)
    expect(() => parseRecipe(withField(path, undefined), 'r.json')).toThrow(path)
  })

  it('rejects an id that is not a safe directory name', () => {
    for (const bad of ['../escape', 'Has Space', 'UPPER', '', 'a/b']) {
      expect(() => parseRecipe(withField('id', bad), 'r.json')).toThrow(/id/)
    }
  })

  // A branch or tag makes the build unreproducible: the same recipe produces a
  // different app tomorrow, and a port that worked cannot be shown to still work.
  it('rejects an upstream ref that is not a full commit sha', () => {
    for (const bad of ['main', 'v0.25.3', 'e910be6', 'HEAD', 'e910be68e49015a61af9d6de71632ae3bfc65bag']) {
      expect(() => parseRecipe(withField('upstream.ref', bad), 'r.json')).toThrow(/ref/)
    }
  })

  it('rejects a non-https upstream repo', () => {
    for (const bad of ['git@github.com:a/b.git', 'http://x/y.git', 'file:///tmp/x']) {
      expect(() => parseRecipe(withField('upstream.repo', bad), 'r.json')).toThrow(/repo/)
    }
  })

  it('rejects a port outside the unprivileged range', () => {
    for (const bad of [0, 80, 1023, 70000, 8875.5, -1]) {
      expect(() => parseRecipe(withField('port', bad), 'r.json')).toThrow(/port/)
    }
  })

  // `output`, `manifest` and every other path is joined onto a directory we
  // own. One that climbs out writes into the repository, or worse.
  it('rejects paths that escape their base', () => {
    expect(() => parseRecipe(withField('build.output', '../../etc'), 'r.json')).toThrow(/output/)
    expect(() => parseRecipe(withField('manifest', '/etc/passwd'), 'r.json')).toThrow(/manifest/)
  })

  it('defaults entry to index.html and bridge injection to head-first', () => {
    const recipe = parseRecipe(withField('bridge', { file: 'bridge/b.js' }), 'r.json')
    expect(recipe.entry).toBe('index.html')
    expect(recipe.bridge?.inject).toBe('head-first')
  })

  it('rejects an unknown top-level key rather than ignoring it', () => {
    expect(() => parseRecipe(withField('bulid', {}), 'r.json')).toThrow(/bulid/)
  })
})

describe('expandTokens', () => {
  const dirs = { recipe: '/repo/apps/ft', source: '/repo/out/ft/source', static: '/repo/out/ft/static' }

  it('substitutes every known token', () => {
    expect(expandTokens('npx webpack --config {recipe}/w.cjs', dirs))
      .toBe('npx webpack --config /repo/apps/ft/w.cjs')
    expect(expandTokens('cp {source}/a {static}/b', dirs))
      .toBe('cp /repo/out/ft/source/a /repo/out/ft/static/b')
  })

  it('throws on an unknown token rather than leaving it in the command', () => {
    expect(() => expandTokens('rm -rf {oout}/x', dirs)).toThrow(/oout/)
  })
})

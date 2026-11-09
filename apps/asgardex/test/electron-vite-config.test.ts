// The build wrapper removes the renderer's TypeScript plugin and nothing else, and says so loudly when upstream's
// config stops having exactly one: a quiet pass here is a renderer whose bytes depend on module load order again.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { withoutTypescriptPlugin } from '../electron.vite.orivon.config.mjs'

const named = (name: string): { name: string } => ({ name })
const main = { plugins: [named('typescript'), named('vite:externalize-deps')] }

describe('withoutTypescriptPlugin', () => {
  it('drops the renderer typescript plugin and keeps every other plugin in order', () => {
    const config = { main, preload: {}, renderer: { build: { sourcemap: false }, plugins: [named('vite-plugin-wasm'), [named('vite:react-babel')], named('typescript'), named('vite-plugin-svgr')] } }
    const wrapped = withoutTypescriptPlugin(config)
    expect(wrapped.renderer.plugins).toEqual([named('vite-plugin-wasm'), [named('vite:react-babel')], named('vite-plugin-svgr')])
    expect(wrapped.renderer.build).toEqual({ sourcemap: false })
    expect(wrapped.main).toBe(main)
    expect(config.renderer.plugins).toHaveLength(4)
  })

  it('refuses a renderer with no typescript plugin, or with two', () => {
    expect(() => withoutTypescriptPlugin({ renderer: { plugins: [named('vite-plugin-svgr')] } })).toThrow(/exactly one "typescript"/)
    expect(() => withoutTypescriptPlugin({ renderer: { plugins: [named('typescript'), named('typescript')] } })).toThrow(/found 2/)
  })

  it('refuses a config with no renderer plugin list', () => {
    expect(() => withoutTypescriptPlugin({})).toThrow(/renderer\.plugins/)
    expect(() => withoutTypescriptPlugin({ renderer: {} })).toThrow(/renderer\.plugins/)
  })
})

describe('the recipe', () => {
  it('copies the wrapper into the clone and builds with it', () => {
    const recipe = JSON.parse(readFileSync(new URL('../recipe.json', import.meta.url), 'utf8')) as { build: { command: string } }
    const command = recipe.build.command
    expect(command).toContain('cp {recipe}/electron.vite.orivon.config.mjs .')
    expect(command).toMatch(/cjs build -c electron\.vite\.orivon\.config\.mjs$/)
  })
})

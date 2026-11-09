import { describe, expect, it } from 'vitest'
import { shimPathProblems } from './shim-paths.ts'

const wrapper = (build: string, path = 'apps/x/esbuild.orivon.config.mjs') => [{
  path,
  text: `import { loadShimPlugin, stableBundlePaths } from '../../src/build/esbuild-kit.mjs'\nconst { orivonShimPlugin } = await loadShimPlugin()\n${build}\n`
}]

describe('shimPathProblems', () => {
  it('passes a wrapper whose plugins end with stableBundlePaths()', () => {
    expect(shimPathProblems(wrapper('await esbuild.build({ plugins: [portPlugin(), orivonShimPlugin(), stableBundlePaths()] })'))).toEqual([])
  })

  it('passes a plugins list that spans lines and holds calls with arguments', () => {
    const build = 'await esbuild.build({\n  plugins: [\n    backend({ a: [1, 2] }),\n    orivonShimPlugin(),\n    stableBundlePaths({ env })\n  ]\n})'
    expect(shimPathProblems(wrapper(build))).toEqual([])
  })

  it('names a plugins list that leaves stableBundlePaths() out', () => {
    expect(shimPathProblems(wrapper('await esbuild.build({\n  plugins: [orivonShimPlugin()]\n})'))).toEqual([
      'apps/x/esbuild.orivon.config.mjs:4: the plugins list passes orivonShimPlugin() and does not end with stableBundlePaths(), so the bundle names the folder orivon-mvp was checked out in (src/build/esbuild-kit.mjs)'
    ])
  })

  it('names a stableBundlePaths() that is not last, because a plugin after it writes bytes it never sees', () => {
    expect(shimPathProblems(wrapper('await esbuild.build({ plugins: [orivonShimPlugin(), stableBundlePaths(), later()] })'))).toHaveLength(1)
  })

  it('names the one build of several that lacks it', () => {
    const build = 'await esbuild.build({ plugins: [orivonShimPlugin(), stableBundlePaths()] })\nawait esbuild.build({ plugins: [orivonShimPlugin()] })'
    const problems = shimPathProblems(wrapper(build))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/:4:/)
  })

  it('does not count a stableBundlePaths() in another list', () => {
    const build = 'await esbuild.build({ plugins: [orivonShimPlugin()] })\nawait esbuild.build({ plugins: [other(), stableBundlePaths()] })'
    expect(shimPathProblems(wrapper(build))).toHaveLength(1)
  })

  it('names a shim plugin passed outside a literal plugins list', () => {
    const problems = shimPathProblems(wrapper('const list = [orivonShimPlugin(), stableBundlePaths()]\nawait esbuild.build({ plugins: list })'))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/outside a literal/)
  })

  it('names a wrapper that loads the shim plugin and never passes it', () => {
    expect(shimPathProblems(wrapper('await esbuild.build({ plugins: [] })'))).toEqual([
      'apps/x/esbuild.orivon.config.mjs: loads the shim plugin (loadShimPlugin) and never passes orivonShimPlugin() to esbuild'
    ])
  })

  it('ignores a call that only a comment holds', () => {
    const build = '// plugins: [orivonShimPlugin()] was once enough\n/* plugins: [orivonShimPlugin()] */\nawait esbuild.build({ plugins: [orivonShimPlugin(), stableBundlePaths()] })'
    expect(shimPathProblems(wrapper(build))).toEqual([])
  })

  it('keeps a URL in a string from hiding the rest of its line', () => {
    const build = "const home = 'https://example.org'; await esbuild.build({ plugins: [orivonShimPlugin()] })"
    expect(shimPathProblems(wrapper(build))).toHaveLength(1)
  })

  it('leaves a file that never touches the shim alone', () => {
    expect(shimPathProblems([{ path: 'apps/x/build.mjs', text: 'await esbuild.build({ plugins: [portPlugin()] })\n' }])).toEqual([])
  })
})

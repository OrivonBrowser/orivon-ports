import { describe, expect, it } from 'vitest'
import { editionDirs, installDirFor, installFileProblems, isInstallFile, kernelProblems, packNameProblems, packOf } from './install-plan.js'

const DIRS = ['plugins/tiddlywiki/filesystem/', 'plugins/tiddlywiki/tiddlyweb/', 'themes/tiddlywiki/vanilla/']

describe('the directories the shipped editions name', () => {
  const server = '{"plugins":["tiddlywiki/tiddlyweb","tiddlywiki/filesystem"],"themes":["tiddlywiki/vanilla"]}'
  const empty = '{"plugins":[],"themes":["tiddlywiki/vanilla","tiddlywiki/snowwhite"],"languages":["de-DE"]}'

  it('lists each plugin, theme and language once, as a directory prefix', () => {
    expect(editionDirs([server, empty])).toEqual([
      'languages/de-DE/', 'plugins/tiddlywiki/filesystem/', 'plugins/tiddlywiki/tiddlyweb/', 'themes/tiddlywiki/snowwhite/', 'themes/tiddlywiki/vanilla/'
    ])
  })

  it('takes an edition that names nothing as naming nothing', () => {
    expect(editionDirs(['{"description":"x"}'])).toEqual([])
  })

  it('refuses a name that climbs out or is absolute', () => {
    expect(() => editionDirs(['{"plugins":["../x"]}'])).toThrow('not a directory name')
    expect(() => editionDirs(['{"plugins":["/x"]}'])).toThrow('not a directory name')
    expect(() => editionDirs(['{"plugins":[3]}'])).toThrow('not a directory name')
  })
})

describe('which files of the clone the server reads', () => {
  it('takes the kernel and the core whole, package.json, and the directories the editions name', () => {
    for (const rel of ['package.json', 'boot/boot.js', 'core/plugin.info', 'core/modules/startup/favicon.js', 'core-server/server/server.js',
      'plugins/tiddlywiki/tiddlyweb/plugin.info', 'themes/tiddlywiki/vanilla/base.tid']) {
      expect(isInstallFile(rel, DIRS), rel).toBe(true)
    }
  })

  it('leaves out a plugin, theme or language no shipped edition names', () => {
    for (const rel of ['plugins/tiddlywiki/geospatial/plugin.info', 'plugins/tiddlywiki/tiddlywebx/plugin.info', 'themes/tiddlywiki/starlight/plugin.info', 'languages/de-DE/plugin.info']) {
      expect(isInstallFile(rel, DIRS), rel).toBe(false)
    }
  })

  it('takes the server and empty editions only, not upstream\'s documentation and test wikis', () => {
    expect(isInstallFile('editions/server/tiddlywiki.info', DIRS)).toBe(true)
    expect(isInstallFile('editions/empty/tiddlywiki.info', DIRS)).toBe(true)
    expect(isInstallFile('editions/tw5.com/tiddlers/HelloThere.tid', DIRS)).toBe(false)
    expect(isInstallFile('editions/test/tiddlywiki.info', DIRS)).toBe(false)
    expect(isInstallFile('editions/server', DIRS)).toBe(false)
  })

  it('leaves out everything else at the top: the command-line launcher, the docs, the repository\'s own tooling', () => {
    for (const rel of ['tiddlywiki.js', 'readme.md', 'license', 'bin/build-site.sh', 'community/people.tid', 'eslint.config.mjs', '.github/workflows/ci.yml', 'boot']) {
      expect(isInstallFile(rel, DIRS), rel).toBe(false)
    }
  })

  it('refuses a path that climbs out', () => {
    expect(isInstallFile('boot/../../etc/passwd', DIRS)).toBe(false)
    expect(isInstallFile('/boot/boot.js', DIRS)).toBe(false)
  })
})

describe('what a complete install tree holds', () => {
  const complete = ['package.json', 'boot/boot.js', 'boot/bootprefix.js', 'core/plugin.info', 'core-server/plugin.info', 'core-server/server/server.js',
    'plugins/tiddlywiki/tiddlyweb/plugin.info', 'plugins/tiddlywiki/filesystem/plugin.info', 'themes/tiddlywiki/vanilla/plugin.info', 'editions/server/tiddlywiki.info']

  it('is nothing missing', () => {
    expect(installFileProblems(complete)).toEqual([])
  })

  it('names each required file that is gone and what it was for', () => {
    const problems = installFileProblems(complete.filter((name) => name !== 'editions/server/tiddlywiki.info' && name !== 'boot/boot.js'))
    expect(problems).toHaveLength(2)
    expect(problems.join('\n')).toContain('boot/boot.js is missing: the kernel')
    expect(problems.join('\n')).toContain('editions/server/tiddlywiki.info is missing')
  })
})

describe('the names a pack may hold', () => {
  it('accepts relative names that differ in more than case', () => {
    expect(packNameProblems(['boot/boot.js', 'core/a.tid', 'core/b.tid'])).toEqual([])
  })

  it('refuses a name that climbs out, is absolute, has an empty part or a backslash', () => {
    for (const name of ['../x', 'a/../b', '/a', 'a//b', 'a\\b', './a', '']) {
      expect(packNameProblems([name]), name).toHaveLength(1)
    }
  })

  it('refuses two names that differ only by case, which one file on a case-insensitive disk would overwrite', () => {
    expect(packNameProblems(['core/Readme.tid', 'core/README.tid'])).toEqual(['core/README.tid differs from core/Readme.tid only by case'])
  })
})

describe('the pack', () => {
  it('lists each file with its size and holds the bytes end to end', () => {
    const { index, body } = packOf([['a', Buffer.from('xyz')], ['b', Buffer.alloc(0)], ['c', Buffer.from('12')]])
    expect(index).toEqual([['a', 3], ['b', 0], ['c', 2]])
    expect(body.toString()).toBe('xyz12')
  })

  it('names the install directory by stamp, under the one parent the launcher cleans', () => {
    expect(installDirFor('abc')).toBe('wikifolder-install/abc')
  })
})

describe('the kernel the vm stand-in was written for', () => {
  const kernel = [
    'var vm = require("vm");',
    'var sandbox = vm.createContext({});',
    'fn = vm.runInContext(code,sandbox,filename);',
    'fn = vm.runInThisContext(code,filename);',
    '"  if(Object.keys(__temp__).length){",'
  ].join('\n')

  it('is accepted when it calls only the three members and reads the probe through __temp__', () => {
    expect(kernelProblems(kernel)).toEqual([])
  })

  it('names a vm member the stand-in does not answer', () => {
    expect(kernelProblems(`${kernel}\nvm.runInNewContext(code)`)).toEqual(['boot/boot.js calls vm.runInNewContext, which the stand-in does not answer'])
  })

  it('names a member the stand-in answers that the kernel no longer calls', () => {
    expect(kernelProblems(kernel.replace('vm.createContext({})', 'makeContext({})'))).toEqual(['boot/boot.js no longer calls vm.createContext: the stand-in answers a call that is gone'])
  })

  it('names a global check that no longer reads through __temp__', () => {
    expect(kernelProblems(kernel.replace('Object.keys(__temp__)', 'Object.keys(leaked)'))).toHaveLength(1)
  })
})

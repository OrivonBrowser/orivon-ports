import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { recipeShell, SHELL_ENV, shellQuote } from './shell.ts'

describe('recipeShell', () => {
  it('is the platform sh outside Windows', () => {
    expect(recipeShell({}, 'linux')).toBe(true)
    expect(recipeShell({}, 'darwin')).toBe(true)
  })

  it(`takes ${SHELL_ENV} over anything it would find`, () => {
    expect(recipeShell({ [SHELL_ENV]: '/opt/bin/dash' }, 'win32')).toBe('/opt/bin/dash')
    expect(recipeShell({ [SHELL_ENV]: '/opt/bin/dash' }, 'linux')).toBe('/opt/bin/dash')
  })

  it.runIf(process.platform === 'win32')('finds a bash on Windows that runs POSIX syntax cmd.exe cannot', () => {
    const shell = recipeShell({}, 'win32')
    expect(typeof shell).toBe('string')
    const out = execFileSync(shell as string, ['-c', `FOO=bar sh -c 'echo "$FOO"' && echo ${shellQuote('a b')}`], { encoding: 'utf8' })
    expect(out.split(/\r?\n/).slice(0, 2)).toEqual(['bar', 'a b'])
  })
})

describe('shellQuote', () => {
  it('makes one literal argument of a path with spaces, quotes, dollars and backslashes', () => {
    expect(shellQuote(String.raw`C:\Users\Jo O'Neil\$HOME`)).toBe(String.raw`'C:\Users\Jo O'\''Neil\$HOME'`)
  })
})

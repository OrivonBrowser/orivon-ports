import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { REPO_ROOT } from './paths.ts'

// The command line around recon: what it refuses, and what it only reports.
let clone: string
beforeAll(async () => {
  clone = await mkdtemp(join(tmpdir(), 'orivon-recon-cli-'))
  await mkdir(join(clone, 'src'), { recursive: true })
  await writeFile(join(clone, 'src/a.js'), "const fs = require('fs')\nfs.readFileSync(p)")
})
afterAll(async () => { await rm(clone, { recursive: true, force: true }) })

const run = (args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> =>
  new Promise((resolve) => {
    execFile(process.execPath, ['src/cli.ts', 'recon', ...args], { cwd: REPO_ROOT, env: { ...process.env, ORIVON_MVP_ROOT: '', ...env } }, (error, out, err) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, out, err })
    })
  })

describe('orivon-port recon', () => {
  it('exits 1 for a clone that is not a directory', async () => {
    const result = await run([join(clone, 'nowhere')])
    expect(result.code).toBe(1)
    expect(result.err).toContain('is not a directory')
  })

  it('exits 1 for --mvp with no value, or naming a path without the tables', async () => {
    const bare = await run([clone, '--mvp'])
    expect(bare.code).toBe(1)
    expect(bare.err).toContain('--mvp needs the path')
    const missing = await run([clone, '--mvp', join(clone, 'no-mvp')])
    expect(missing.code).toBe(1)
    expect(missing.err).toContain('no orivon-mvp compatibility tables')
  })

  it('still reports the usage when only the environment variable names a missing checkout', async () => {
    const result = await run([clone], { ORIVON_MVP_ROOT: join(clone, 'no-mvp') })
    expect(result.code).toBe(0)
    expect(result.out).toContain('No orivon-mvp checkout was found')
    expect(result.out).toContain('`fs.readFileSync`')
  })

  it('accepts a relative path to the clone', async () => {
    const result = await run([relative(REPO_ROOT, clone)], { ORIVON_MVP_ROOT: join(clone, 'no-mvp') })
    expect(result.code).toBe(0)
    expect(result.out).toContain('`fs.readFileSync`')
  })
})

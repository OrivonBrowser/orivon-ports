import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ELECTRON_TABLE, loadCompat, mvpCandidate, NATIVE_TABLE, NODE_TABLE } from './compat-tables.ts'
import type { Compat } from './compat-tables.ts'

// What the parsers must still find in orivon-mvp's real tables. If mvp changes a
// table's shape and the parsers read less than this, recon's verdicts would
// quietly thin out; this fails first, in whichever repository changed.
export function driftProblems (compat: Compat): string[] {
  const problems: string[] = []
  const { electron, nodeModules, nativePackages, electronPackages } = compat.stats
  // compat.warnings below also carry any malformed row and any missing file.
  if (electron.rows < 40) problems.push(`table 2b: ${String(electron.rows)} rows read, at least 40 expected`)
  for (const status of ['works', 'limits', 'excluded', 'missing'] as const) {
    if (!electron.statuses.includes(status)) problems.push(`table 2b: no row with status "${status}"`)
  }
  if (nodeModules.names < 40) problems.push(`table 2a: ${String(nodeModules.names)} modules read, at least 40 expected`)
  if (nativePackages.names < 20) problems.push(`table 5: ${String(nativePackages.names)} packages read, at least 20 expected`)
  if (electronPackages.names < 10) problems.push(`table 2c: ${String(electronPackages.names)} packages read, at least 10 expected`)
  if (compat.stats.refusalModules < 10) problems.push(`generated refusals: ${String(compat.stats.refusalModules)} modules read, at least 10 expected`)
  for (const warning of compat.warnings) problems.push(warning)
  return problems
}

const mvp = mvpCandidate(undefined, process.env).path
const present = existsSync(join(mvp, ELECTRON_TABLE))

describe.skipIf(!present)('the real orivon-mvp tables', () => {
  it('still parse to what recon relies on', async () => {
    expect(driftProblems(await loadCompat(mvp))).toEqual([])
  })

  it('give the rows a porter is told about their verdicts', async () => {
    const compat = await loadCompat(mvp)
    expect(compat.electron.get('dialog.showOpenDialog')?.[0]?.status).toBe('missing')
    expect(compat.electron.get('BrowserWindow')?.some((row) => row.status === 'excluded')).toBe(true)
    expect(compat.electron.get('app.getPath')?.length).toBeGreaterThan(1)
    expect(compat.nodeModules.get('fs')?.[0]?.status).toBe('limits')
    expect(compat.refusals.get('fs')?.names.size).toBeGreaterThan(0)
  })
})

// The guard has to be able to fail: these feed it the real tables damaged the ways a drift would.
describe.skipIf(!present)('the drift guard', () => {
  let copy: string
  beforeEach(async () => {
    copy = await mkdtemp(join(tmpdir(), 'orivon-drift-'))
    await mkdir(join(copy, 'docs/planning'), { recursive: true })
    await cp(join(mvp, 'docs/planning/compatibility'), join(copy, 'docs/planning/compatibility'), { recursive: true })
    await cp(join(mvp, 'src/shim'), join(copy, 'src/shim'), { recursive: true, filter: (from) => statSync(from).isDirectory() || from.includes('/generated/') })
  })
  afterEach(async () => { await rm(copy, { recursive: true, force: true }) })

  const damage = async (file: string, change: (text: string) => string): Promise<void> => {
    await writeFile(join(copy, file), change(await readFile(join(copy, file), 'utf8')))
  }

  it('fails when the status column of table 2b is gone', async () => {
    await damage(ELECTRON_TABLE, (text) => text.replace(/[✅⚠🚫❌➖]️?/gu, ''))
    const problems = driftProblems(await loadCompat(copy))
    expect(problems.join('\n')).toContain('table 2b: 0 rows read')
  })

  it('fails when table 2a loses its header, and table 5 its verdict column', async () => {
    await damage(NODE_TABLE, (text) => text.replace('| Module |', '| Specifier |'))
    await damage(NATIVE_TABLE, (text) => text.replace(/\| Library \|/g, '| Name |'))
    const problems = driftProblems(await loadCompat(copy))
    expect(problems.join('\n')).toContain('table 2a: 0 modules read')
    expect(problems.join('\n')).toContain('table 5: 0 packages read')
  })

  it('fails when the generated refusal lists are gone', async () => {
    await rm(join(copy, 'src/shim'), { recursive: true })
    expect(driftProblems(await loadCompat(copy)).join('\n')).toContain('generated refusals: 0 modules read')
  })

  it('fails when a row is cut short', async () => {
    await damage(NODE_TABLE, (text) => text.replace('| `fs` | ⚠️ partial |', '| `fs` |'))
    expect(driftProblems(await loadCompat(copy)).join('\n')).toContain('table 2a (docs/planning/compatibility/table-2a-node-modules.md): 1 row(s) skipped')
  })
})

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Two runs must never share one source tree. The second would check out a
// different ref under the first one's build, and the failure surfaces as a
// build error in somebody else's code -- the most expensive kind to diagnose.

const LOCK_FILE = '.lock'

function isAlive (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function acquireLock (dir: string, label: string): Promise<() => Promise<void>> {
  const path = join(dir, LOCK_FILE)
  await mkdir(dir, { recursive: true })

  try {
    await writeFile(path, String(process.pid), { flag: 'wx' })
  } catch {
    const holder = Number(await readFile(path, 'utf8').catch(() => ''))
    if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) {
      throw new Error(`${label} is locked by process ${String(holder)} -- another run is using ${dir}`)
    }
    // The holder is gone: a run that was killed before it could release. Its
    // work is unfinished, but the tree is nobody's, so take it.
    await writeFile(path, String(process.pid))
  }

  return async () => { await rm(path, { force: true }) }
}

import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * The one flag set an app's tree is added to IPFS with. `-H` is required
 * because the manifest lives in `.well-known/`. Every published app's CID was
 * made with exactly these flags, so changing one changes every CID: the CLI's
 * `cid` and `verify` commands, the attested build workflow and the
 * maintenance guide all read this constant or quote it, and a test fails when
 * the guide drifts from it. The browser's own release packages use a
 * different set, which names each default explicitly; app trees do not.
 */
export const IPFS_ADD_FLAGS = ['-r', '-H', '--cid-version=1', '-Q'] as const

/** The command a person types to pin a tree, as the maintenance guide writes it. */
export function ipfsAddCommand (target: string = '<dir>'): string {
  return `ipfs add ${IPFS_ADD_FLAGS.join(' ')} ${target}`
}

export class IpfsMissingError extends Error {
  constructor () {
    super('the `ipfs` command (Kubo) is not on PATH -- install Kubo to compute a CID')
    this.name = 'IpfsMissingError'
  }
}

async function ipfs (args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ipfs', [...args], { env, maxBuffer: 16 * 1024 * 1024 })
    return stdout.trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new IpfsMissingError()
    const stderr = (error as { stderr?: unknown }).stderr
    throw new Error(`ipfs ${args.join(' ')} failed: ${typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : (error instanceof Error ? error.message : String(error))}`)
  }
}

/** The installed Kubo's version, e.g. `0.43.1`, or undefined with no `ipfs` on PATH. */
export async function kuboVersion (): Promise<string | undefined> {
  try {
    return await ipfs(['version', '--number'], process.env)
  } catch (error) {
    if (error instanceof IpfsMissingError) return undefined
    throw error
  }
}

/**
 * The root CID `ipfs add` gives a directory, computed offline in a throwaway
 * repository so nothing is pinned and no daemon or network is involved.
 */
export async function cidOfTree (dir: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'orivon-ipfs-'))
  const env = { ...process.env, IPFS_PATH: repo }
  try {
    await ipfs(['init', '--empty-repo'], env)
    return await ipfs(['add', '--only-hash', ...IPFS_ADD_FLAGS, dir], env)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}

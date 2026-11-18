// The list of files a page needs to run Bitsocial Node's Worker, each with its size and sha256: what another app's
// build checks the copy it makes against. `bundle.json` in the built tree is this list, and `files` names the
// directories a copy takes whole.

import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** What a page serves for the node, relative to the built tree. */
export const BUNDLE_PARTS = ['node', 'node-client.js', 'node-dashboard.js', 'bin']

/** @param {string} root @param {string} part @returns {Promise<string[]>} */
async function pathsUnder (root, part) {
  const entries = await readdir(join(root, part), { withFileTypes: true }).catch(() => null)
  if (entries === null) return [part]
  const found = await Promise.all(entries.map((entry) => pathsUnder(root, `${part}/${entry.name}`)))
  return found.flat().sort()
}

/** @param {string} root @returns {Promise<Array<{ path: string, bytes: number, sha256: string }>>} */
export async function bundleFiles (root) {
  const paths = (await Promise.all(BUNDLE_PARTS.map((part) => pathsUnder(root, part)))).flat()
  return Promise.all(paths.map(async (path) => {
    const bytes = await readFile(join(root, path))
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }))
}

/** Writes `bundle.json` into `root`. @param {string} root @param {Record<string, unknown>} about */
export async function writeBundleManifest (root, about) {
  const manifest = { ...about, files: await bundleFiles(root) }
  await writeFile(join(root, 'bundle.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

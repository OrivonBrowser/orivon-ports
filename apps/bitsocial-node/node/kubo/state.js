// What the facade keeps between runs, in one JSON file: the root of the mutable file system and the configuration
// kubo's `config` command reads and writes. Writes are one at a time, each a whole file put in place by a rename.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * @typedef {object} FileSystem
 * @property {typeof readFile} readFile
 * @property {typeof writeFile} writeFile
 * @property {typeof rename} rename
 * @property {typeof mkdir} mkdir
 */

/**
 * @typedef {object} StateData
 * @property {number} version
 * @property {string} [mfsRoot] the CID of the file system's root, flushed
 * @property {string[]} [stalePins] roots that were replaced and are still pinned, to unpin
 * @property {Record<string, unknown>} config
 */

/** @param {{ statePath: string, fs?: FileSystem }} options */
export async function openState ({ statePath, fs = { readFile, writeFile, rename, mkdir } }) {
  /** @type {StateData} */
  let data = { version: 1, config: {} }
  try {
    data = { ...data, ...JSON.parse(String(await fs.readFile(statePath, 'utf8'))) }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
  }
  /** @type {Promise<void>} */
  let writing = Promise.resolve()

  async function persist () {
    await fs.mkdir(dirname(statePath), { recursive: true })
    const temporary = `${statePath}.tmp`
    await fs.writeFile(temporary, JSON.stringify(data, null, 2))
    await fs.rename(temporary, statePath)
  }

  return {
    get mfsRoot () { return data.mfsRoot },
    get stalePins () { return data.stalePins ?? [] },
    get config () { return data.config },
    /** @param {Partial<StateData>} patch */
    async update (patch) {
      data = { ...data, ...patch }
      writing = writing.then(persist, persist)
      await writing
    }
  }
}

/** @typedef {Awaited<ReturnType<typeof openState>>} State */

/** A value in a nested object by its dotted key, or undefined. @param {Record<string, unknown>} root @param {string} key */
export function getPath (root, key) {
  /** @type {unknown} */
  let at = root
  for (const part of key.split('.')) {
    if (typeof at !== 'object' || at === null || !(part in at)) return undefined
    at = /** @type {Record<string, unknown>} */ (at)[part]
  }
  return at
}

/** A copy of `root` with a value set at a dotted key, the objects on the way made as needed. @param {Record<string, unknown>} root @param {string} key @param {unknown} value */
export function withPath (root, key, value) {
  const [head, ...rest] = key.split('.')
  if (head === undefined) return root
  const existing = root[head]
  const child = typeof existing === 'object' && existing !== null && !Array.isArray(existing) ? /** @type {Record<string, unknown>} */ (existing) : {}
  return { ...root, [head]: rest.length === 0 ? value : withPath(child, rest.join('.'), value) }
}

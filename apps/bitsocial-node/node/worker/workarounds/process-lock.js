// Workaround, deletable when `orivon.fs` has file times: the lock pkc-js takes on a community's database while it
// runs. The library it uses (proper-lock-file) holds a lock by making a directory and keeping its modification time
// fresh with `fs.utimes`, which the shim lacks. One Worker holds this app's data directory, so the lock is a set in
// this process; the directory is still made and removed, because pkc-js checks that it exists before it unlocks, and
// one an earlier run left behind is taken over, since nothing else can hold it.

import { promises as fsp, mkdirSync, rmdirSync } from 'fs'

const held = new Set()

/** @param {string} message @param {string} code @param {string} file */
const lockError = (message, code, file) => Object.assign(new Error(message), { code, file })

/** @param {string} file @param {{ lockfilePath?: string }} [options] */
const pathOf = (file, options) => options?.lockfilePath ?? `${file}.lock`

/** @param {{ retries?: number | { retries?: number } }} [options] */
function attemptsOf (options) {
  const { retries } = options ?? {}
  return 1 + (typeof retries === 'number' ? retries : (retries?.retries ?? 0))
}

/**
 * Takes the lock of `file`; resolves a function that releases it. Held, it is tried again `retries` times, as the library does.
 * @param {string} file @param {{ lockfilePath?: string, retries?: number | { retries?: number } }} [options]
 */
export async function lock (file, options) {
  const path = pathOf(file, options)
  for (let attempt = 1; ; attempt++) {
    if (!held.has(path)) break
    if (attempt >= attemptsOf(options)) throw lockError('Lock file is already being held', 'ELOCKED', file)
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, 100 * 2 ** attempt)))
  }
  held.add(path)
  try { await fsp.mkdir(path, { recursive: true }) } catch (error) { held.delete(path); throw error }
  return () => unlock(file, options)
}

/** @param {string} file @param {{ lockfilePath?: string }} [options] */
export async function unlock (file, options) {
  const path = pathOf(file, options)
  if (!held.delete(path)) throw lockError('Lock is not acquired/owned by you', 'ENOTACQUIRED', file)
  await fsp.rmdir(path).catch(() => {})
}

/** @param {string} file @param {{ lockfilePath?: string }} [options] */
export async function check (file, options) {
  return held.has(pathOf(file, options))
}

/** @param {string} file @param {{ lockfilePath?: string }} [options] */
export function lockSync (file, options) {
  const path = pathOf(file, options)
  if (held.has(path)) throw lockError('Lock file is already being held', 'ELOCKED', file)
  held.add(path)
  try { mkdirSync(path, { recursive: true }) } catch (error) { held.delete(path); throw error }
  return () => unlockSync(file, options)
}

/** @param {string} file @param {{ lockfilePath?: string }} [options] */
export function unlockSync (file, options) {
  const path = pathOf(file, options)
  if (!held.delete(path)) throw lockError('Lock is not acquired/owned by you', 'ENOTACQUIRED', file)
  try { rmdirSync(path) } catch { /* already gone */ }
}

/** @param {string} file @param {{ lockfilePath?: string }} [options] */
export function checkSync (file, options) {
  return held.has(pathOf(file, options))
}

export default Object.assign(lock, { lock, unlock, check, lockSync, unlockSync, checkSync })

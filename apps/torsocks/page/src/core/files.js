// TorSocks' files in the app's own storage (orivon.fs), which the daemon
// sees as `/torsocks`:
//
//   torsocks/control.key           the secret a page proves itself with on the control port
//   torsocks/services.json         what the person published, and whether each is on
//   torsocks/sites/<id>/www/       what a service serves
//   torsocks/sites/<id>/site.json  { listing } for the daemon
//   torsocks/arti/                 Arti's state, keys and directory cache (the daemon's)

export const ROOT = 'torsocks'
/** The same directory as the daemon names it: the app's files are its `/`. */
export const DAEMON_ROOT = `/${ROOT}`

const REGISTRY = `${ROOT}/services.json`
const KEY = `${ROOT}/control.key`
const REGISTRY_VERSION = 1

/**
 * The pauses between asks while Orivon's per-app limiter refuses a call, the
 * ones its Node shim and WASI host use: about five seconds in all. The Tor
 * daemon shares the app's budget, so a publication made while it writes its
 * own state can meet the limiter.
 */
const LIMIT_RETRY_MS = [10, 25, 50, 100, 200, 200, 200, 400, 400, 400, 800, 800, 800]

/** `run`, asked again while Orivon refuses it as `limit`: a refused call never ran, so asking again repeats nothing. */
export async function retried (run, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      const wait = LIMIT_RETRY_MS[attempt]
      if (wait === undefined || error?.code !== 'limit') throw error
      await pause(wait)
    }
  }
}

/** `orivon.fs`, each call asked again while the limiter refuses it. */
const fs = () => {
  const real = window.orivon.fs
  return {
    readFile: (path) => retried(() => real.readFile(path)),
    writeFile: (path, data) => retried(() => real.writeFile(path, data)),
    mkdir: (path, opts) => retried(() => real.mkdir(path, opts)),
    rename: (from, to) => retried(() => real.rename(from, to)),
    rm: (path, opts) => retried(() => real.rm(path, opts)),
    open: async (path, flags) => {
      const handle = await retried(() => real.open(path, flags))
      return {
        write: (opts) => retried(() => handle.write(opts)),
        close: () => retried(() => handle.close())
      }
    }
  }
}
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const isNotFound = (error) => error?.code === 'notFound'

async function readText (path) {
  try {
    return decoder.decode(await fs().readFile(path))
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

/** The control key, made once with 32 random bytes and kept. */
export async function controlKey () {
  const kept = (await readText(KEY))?.trim()
  if (kept !== undefined && kept.length >= 32) return kept
  const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')
  await fs().mkdir(ROOT, { recursive: true })
  await fs().writeFile(KEY, encoder.encode(key))
  return key
}

/** The registry's entries; a missing file is none, a damaged one is an error the person sees. */
export async function readRegistry () {
  const text = await readText(REGISTRY)
  if (text === null) return []
  const parsed = JSON.parse(text)
  if (parsed?.version !== REGISTRY_VERSION || !Array.isArray(parsed.services)) throw new Error(`${REGISTRY} is not a file this TorSocks can read`)
  return parsed.services
}

export async function writeRegistry (services) {
  await fs().mkdir(ROOT, { recursive: true })
  const text = JSON.stringify({ version: REGISTRY_VERSION, services }, null, 2)
  // Written beside and renamed over, so a closed tab never leaves half a registry.
  await fs().writeFile(`${REGISTRY}.new`, encoder.encode(text))
  await fs().rename(`${REGISTRY}.new`, REGISTRY)
}

const siteDir = (id) => `${ROOT}/sites/${id}`

/**
 * Writes a publication's files, reporting bytes written as they land. A
 * picked file streams to disk, so a large one is never held in memory. On
 * failure nothing of it is left behind.
 * @param {string} id
 * @param {{ kind: string, listing: unknown, entries: Array<{ path: string, source: Uint8Array | File, size: number }> }} plan
 * @param {(done: number) => void} [onProgress]
 */
export async function writePublication (id, plan, onProgress = () => {}) {
  const www = `${siteDir(id)}/www`
  let done = 0
  const made = new Set()
  const ensureParent = async (path) => {
    const parent = path.slice(0, path.lastIndexOf('/'))
    if (made.has(parent)) return
    await fs().mkdir(parent, { recursive: true })
    made.add(parent)
  }
  try {
    await fs().mkdir(www, { recursive: true })
    made.add(www)
    for (const entry of plan.entries) {
      const path = `${www}/${entry.path}`
      await ensureParent(path)
      if (entry.source instanceof Uint8Array) {
        await fs().writeFile(path, entry.source)
        done += entry.size
        onProgress(done)
      } else {
        await streamFile(path, entry.source, (n) => { done += n; onProgress(done) })
      }
    }
    await fs().writeFile(`${siteDir(id)}/site.json`, encoder.encode(JSON.stringify({ kind: plan.kind, listing: plan.listing })))
  } catch (error) {
    await removePublication(id).catch(() => {})
    throw error
  }
}

/** What one write carries: large enough to keep the round trips few, small enough to hold in memory. */
const WRITE_CHUNK = 1024 * 1024

/**
 * A picked file written a slice at a time with positional writes, which a
 * page's file handle has on every Orivon build; `writable()` is missing on
 * the older ones.
 */
async function streamFile (path, file, onBytes) {
  const handle = await fs().open(path, 'w')
  try {
    for (let position = 0; position < file.size;) {
      const data = new Uint8Array(await file.slice(position, Math.min(position + WRITE_CHUNK, file.size)).arrayBuffer())
      for (let written = 0; written < data.length;) {
        const count = await handle.write({ position: position + written, data: written === 0 ? data : data.subarray(written) })
        if (!(count > 0)) throw new Error(`Writing ${path} stopped after ${String(position + written)} bytes.`)
        written += count
      }
      position += data.length
      onBytes(data.length)
    }
  } finally {
    await handle.close()
  }
}

export async function removePublication (id) {
  try {
    await fs().rm(siteDir(id), { recursive: true })
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
}

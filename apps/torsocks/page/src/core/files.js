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

const fs = () => window.orivon.fs
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

async function streamFile (path, file, onBytes) {
  const handle = await fs().open(path, 'w')
  try {
    const counting = new TransformStream({ transform (chunk, controller) { onBytes(chunk.byteLength); controller.enqueue(chunk) } })
    await file.stream().pipeThrough(counting).pipeTo(handle.writable())
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

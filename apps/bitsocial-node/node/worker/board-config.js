// What the board manager keeps for the boards a person hosts, in the shapes its own CLI keeps them, so a folder of
// either reads in the other: `global.json` (defaults every board takes unless it says otherwise), `boards/<address>/config.json`
// (one board's limits) and `boards/<address>/state.json` (the manager's own: its moderator key and the threads it archived).
// The manager writes `state.json` itself. `enabled` in a board's config is this app's: the manager ignores keys it does not
// know, and a board with no `enabled` is on. `fs` is Node's synchronous file API, because the manager renames a board's folder
// in the middle of its own address change and reads its state the same way.

const NUMBERS = /** @type {const} */ (['perPage', 'pages', 'bumpLimit', 'archivePurgeSeconds'])
const REASONS = /** @type {const} */ (['archiveCapacity', 'purgeArchived', 'purgeDeleted', 'purgeCapacity'])
/** Reasons older configs carry, which the manager reads and ignores: kept as they are, never offered. */
const IGNORED_REASONS = ['archiveBumpLimit', 'lockBumpLimit']
const REASON_MAX = 300
const ADDRESS_FORBIDDEN = /[\\/\0-\x1f]/

export class ConfigError extends Error {}

/**
 * @typedef {object} BoardFields
 * @property {number} [perPage] threads a page of the board's `active` sort holds
 * @property {number} [pages] pages the board keeps; `perPage * pages` threads is its capacity
 * @property {number} [bumpLimit] replies that can still bump a thread, applied through the board's `active` page sort
 * @property {number} [archivePurgeSeconds] how long an archived thread is kept before it is purged
 * @property {Partial<Record<(typeof REASONS)[number], string>>} [moderationReasons] the text a moderation carries
 */
/** @typedef {BoardFields & { address: string, enabled?: boolean }} BoardConfig */
/** @typedef {{ rpcUrl?: string, userAgent?: string, defaults?: BoardFields }} GlobalConfig */

/**
 * @typedef {object} FileApi Node's synchronous file API, which is all the store uses
 * @property {(path: string, encoding: 'utf-8') => string} readFileSync
 * @property {(path: string, data: string) => void} writeFileSync
 * @property {(path: string, options: { recursive: true }) => unknown} mkdirSync
 * @property {(from: string, to: string) => void} renameSync
 * @property {(path: string) => void} unlinkSync
 * @property {(path: string, options: { withFileTypes: true }) => Array<{ name: string, isDirectory: () => boolean }>} readdirSync
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * An address that is safe as a folder name: a `.bso` name or a public key, never a path. A board is named by its address
 * all the way down to the disk, and the address comes from the page.
 * @param {unknown} address
 */
export function checkAddress (address) {
  if (typeof address !== 'string' || address === '' || address.length > 255 || address === '.' || address === '..' || ADDRESS_FORBIDDEN.test(address)) {
    throw new ConfigError('address must be a board address: a name or a public key, 1 to 255 characters, no "/" or "\\"')
  }
  return address
}

/** @param {unknown} value @param {string} name */
function positiveInteger (value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) throw new ConfigError(`${name} must be a positive integer`)
  return value
}

/** @param {unknown} reasons @param {string} name */
function reasonTexts (reasons, name) {
  if (!isObject(reasons)) throw new ConfigError(`${name} must be an object`)
  /** @type {Record<string, string>} */
  const kept = {}
  for (const [key, text] of Object.entries(reasons)) {
    if (!/** @type {readonly string[]} */ (REASONS).includes(key)) throw new ConfigError(`${name} has an unknown key "${key}"`)
    if (typeof text !== 'string' || text === '' || text.length > REASON_MAX) throw new ConfigError(`${name}.${key} must be a text of 1 to ${String(REASON_MAX)} characters`)
    kept[key] = text
  }
  return kept
}

/**
 * The changes a call asks for: a value sets a field, `null` takes it back to the default. A field that is not one of the manager's is
 * refused, so a page cannot write what the manager would never read.
 * @param {unknown} patch @param {{ enabled?: boolean }} [allow] `enabled`: whether the patch may carry it (a board's, never the defaults')
 * @returns {{ set: BoardFields & { enabled?: boolean }, reset: string[] }}
 */
export function checkPatch (patch, { enabled = false } = {}) {
  if (!isObject(patch)) throw new ConfigError('the config must be an object')
  /** @type {Record<string, unknown>} */
  const set = {}
  /** @type {string[]} */
  const reset = []
  for (const [key, value] of Object.entries(patch)) {
    const known = /** @type {readonly string[]} */ (NUMBERS).includes(key) || key === 'moderationReasons' || (enabled && key === 'enabled')
    if (!known) throw new ConfigError(`${key} is not a setting of the board manager`)
    if (value === null) { reset.push(key); continue }
    if (key === 'enabled') { if (typeof value !== 'boolean') throw new ConfigError('enabled must be true or false'); set[key] = value } else if (key === 'moderationReasons') set[key] = reasonTexts(value, key)
    else set[key] = positiveInteger(value, key)
  }
  return { set, reset }
}

/**
 * @param {BoardFields} fields the fields a file or a patch holds @param {{ set: BoardFields, reset: string[] }} change
 * @returns {BoardFields}
 */
export function applyChange (fields, { set, reset }) {
  /** @type {Record<string, unknown>} */
  const next = { ...fields, ...set }
  for (const key of reset) delete next[key]
  return /** @type {BoardFields} */ (next)
}

/**
 * Reads a file the board manager wrote, or a person edited: what is wrong with it is a `ConfigError` naming the file.
 * @param {string} path @param {string} text
 */
function parsed (path, text) {
  /** @type {unknown} */
  let value
  try { value = JSON.parse(text) } catch (error) { throw new ConfigError(`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`) }
  if (!isObject(value)) throw new ConfigError(`${path} must hold a JSON object`)
  return value
}

/** @param {Record<string, unknown>} fields @param {string} path */
function checkedFields (fields, path) {
  for (const name of NUMBERS) if (fields[name] !== undefined) positiveInteger(fields[name], `${path}: ${name}`)
  if (fields['moderationReasons'] !== undefined) {
    if (!isObject(fields['moderationReasons'])) throw new ConfigError(`${path}: moderationReasons must be an object`)
    for (const [key, text] of Object.entries(fields['moderationReasons'])) {
      if (!/** @type {readonly string[]} */ ([...REASONS, ...IGNORED_REASONS]).includes(key) || typeof text !== 'string') throw new ConfigError(`${path}: moderationReasons.${key} is not a reason text`)
    }
  }
  return fields
}

/** @param {{ directory: string, fs: FileApi }} options `directory`: where `global.json` and `boards/` live */
export function boardConfigStore ({ directory, fs }) {
  const globalPath = `${directory}/global.json`
  const boardsPath = `${directory}/boards`
  /** @param {string} address */
  const boardPath = (address) => `${boardsPath}/${checkAddress(address)}`
  /** @param {string} path */
  const readOrNull = (path) => {
    try { return fs.readFileSync(path, 'utf-8') } catch (error) { if (/** @type {any} */ (error)?.code === 'ENOENT') return null; throw error }
  }
  /** Writes next to the file and renames over it, as the manager does, so a stop in the middle leaves the old file. @param {string} path @param {unknown} value */
  function writeJson (path, value) {
    fs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
    const temporary = `${path}.tmp`
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
      fs.renameSync(temporary, path)
    } catch (error) {
      try { fs.unlinkSync(temporary) } catch { /* nothing was written */ }
      throw error
    }
  }

  return {
    directory,
    /** Where the board manager keeps one board's `state.json`. @param {string} address */
    boardDir: boardPath,
    /**
     * Everything on disk. A board whose file cannot be read is named in `problems` and left out, since one broken file must not stop the others.
     * @returns {{ global: GlobalConfig, boards: BoardConfig[], problems: string[] }}
     */
    load () {
      /** @type {string[]} */
      const problems = []
      /** @type {GlobalConfig} */
      let global = {}
      try {
        const text = readOrNull(globalPath)
        if (text !== null) {
          const value = parsed(globalPath, text)
          if (value['defaults'] !== undefined) {
            if (!isObject(value['defaults'])) throw new ConfigError(`${globalPath}: defaults must be an object`)
            checkedFields(value['defaults'], `${globalPath}: defaults`)
          }
          global = /** @type {GlobalConfig} */ (value)
        }
      } catch (error) { problems.push(error instanceof Error ? error.message : String(error)) }
      /** @type {BoardConfig[]} */
      const boards = []
      /** @type {Array<{ name: string, isDirectory: () => boolean }>} */
      let entries = []
      try { entries = fs.readdirSync(boardsPath, { withFileTypes: true }) } catch (error) { if (/** @type {any} */ (error)?.code !== 'ENOENT') problems.push(`${boardsPath} cannot be read: ${error instanceof Error ? error.message : String(error)}`) }
      for (const entry of entries.filter((one) => one.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const path = `${boardsPath}/${entry.name}/config.json`
        try {
          const text = readOrNull(path)
          if (text === null) continue
          const value = parsed(path, text)
          if (value['address'] !== entry.name) throw new ConfigError(`${path}: the folder is "${entry.name}" and the address is ${JSON.stringify(value['address'])}`)
          checkedFields(value, path)
          if (value['enabled'] !== undefined && typeof value['enabled'] !== 'boolean') throw new ConfigError(`${path}: enabled must be true or false`)
          boards.push(/** @type {BoardConfig} */ (value))
        } catch (error) { problems.push(error instanceof Error ? error.message : String(error)) }
      }
      return { global, boards, problems }
    },
    /** @param {BoardConfig} config */
    writeBoard (config) { writeJson(`${boardPath(config.address)}/config.json`, config) },
    /** @param {GlobalConfig} config */
    writeGlobal (config) { writeJson(globalPath, config) },
    /**
     * The manager's own address change: the board's folder and the address in its config take the new name, at once, because the
     * manager then takes its lock under the new path.
     * @param {string} from @param {string} to
     */
    renameBoard (from, to) {
      const source = boardPath(from)
      const target = boardPath(to)
      if (readOrNull(`${target}/config.json`) !== null) throw new ConfigError(`the config of ${to} exists already, so ${from} cannot take that name`)
      fs.renameSync(source, target)
      const text = readOrNull(`${target}/config.json`)
      if (text !== null) writeJson(`${target}/config.json`, { ...parsed(`${target}/config.json`, text), address: to })
    },
    /** How many threads the manager has archived and not yet purged; the state file's key is never read out. @param {string} address */
    archivedThreads (address) {
      try {
        const text = readOrNull(`${boardPath(address)}/state.json`)
        if (text === null) return 0
        const archived = parsed('state.json', text)['archivedThreads']
        return isObject(archived) ? Object.keys(archived).length : 0
      } catch { return 0 }
    }
  }
}

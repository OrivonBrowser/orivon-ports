// What seeding keeps in the app's files, `seeding/state.json`: whether it is on, the space it may use, the communities a person
// follows or added, the ones they took out of the list, and what the node holds for it (the ledger: each pin seeding made,
// so that turning seeding off unpins exactly those and nothing a hosted community needs). `fs` is Node's synchronous file API.

import { checkAddress, ConfigError } from './board-config.js'

/** The space seeding may use unless a person sets another, and the bounds a limit is checked against (decimal, as the dashboard shows sizes). */
export const LIMIT_DEFAULT = 1e9
export const LIMIT_MIN = 1e6
export const LIMIT_MAX = 1e12
/** A list longer than this is cut: every community on it is one open update loop of pkc-js. */
export const COMMUNITIES_MAX = 200

/**
 * @typedef {object} Pin one root the node holds for a community
 * @property {string} cid @property {string} name what it is in the record @property {number} bytes @property {boolean} owned seeding made the pin, so seeding may take it away
 * @typedef {{ address: string, origin: 'followed' | 'added', addedAt: number }} Entry
 * @typedef {{ pins: Pin[], recordAt: number | null, updatedAt: number }} Held
 * @typedef {{ at: number, tookMs: number, communities: number, holding: number }} Run
 * @typedef {{ version: 1, enabled: boolean, limitBytes: number, communities: Entry[], ignored: string[], held: Record<string, Held>, lastRun: Run | null }} SeedingState
 */

/** @returns {SeedingState} */
export const blank = () => ({ version: 1, enabled: false, limitBytes: LIMIT_DEFAULT, communities: [], ignored: [], held: {}, lastRun: null })

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** @param {unknown} value */
const goodAddress = (value) => { try { checkAddress(value); return true } catch { return false } }

/** A file read back is trusted for its shape only: a field that is not what it should be is left at its default. @param {unknown} raw @returns {SeedingState} */
export function normalise (raw) {
  const made = blank()
  if (!isObject(raw)) return made
  if (raw['enabled'] === true) made.enabled = true
  if (typeof raw['limitBytes'] === 'number' && Number.isInteger(raw['limitBytes']) && raw['limitBytes'] >= LIMIT_MIN && raw['limitBytes'] <= LIMIT_MAX) made.limitBytes = raw['limitBytes']
  const seen = new Set()
  for (const one of Array.isArray(raw['communities']) ? raw['communities'] : []) {
    if (!isObject(one) || !goodAddress(one['address']) || seen.has(one['address']) || made.communities.length >= COMMUNITIES_MAX) continue
    seen.add(one['address'])
    made.communities.push({ address: one['address'], origin: one['origin'] === 'added' ? 'added' : 'followed', addedAt: typeof one['addedAt'] === 'number' ? one['addedAt'] : 0 })
  }
  made.ignored = (Array.isArray(raw['ignored']) ? raw['ignored'] : []).filter(goodAddress).slice(0, 1000)
  for (const [address, one] of isObject(raw['held']) ? Object.entries(raw['held']) : []) {
    if (!goodAddress(address) || !isObject(one)) continue
    const pins = (Array.isArray(one['pins']) ? one['pins'] : []).filter((pin) => isObject(pin) && typeof pin['cid'] === 'string' && typeof pin['bytes'] === 'number')
    made.held[address] = { pins: pins.map((pin) => ({ cid: pin['cid'], name: String(pin['name'] ?? ''), bytes: Math.max(0, pin['bytes']), owned: pin['owned'] === true })), recordAt: typeof one['recordAt'] === 'number' ? one['recordAt'] : null, updatedAt: typeof one['updatedAt'] === 'number' ? one['updatedAt'] : 0 }
  }
  const run = raw['lastRun']
  if (isObject(run) && typeof run['at'] === 'number') made.lastRun = { at: run['at'], tookMs: Number(run['tookMs']) || 0, communities: Number(run['communities']) || 0, holding: Number(run['holding']) || 0 }
  return made
}

/** @param {unknown} bytes a limit a page sent */
export function checkLimit (bytes) {
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < LIMIT_MIN || bytes > LIMIT_MAX) throw new ConfigError(`the space limit must be a whole number of bytes, from 1 MB (${String(LIMIT_MIN)}) to 1 TB (${String(LIMIT_MAX)})`)
  return bytes
}

/** @param {{ directory: string, fs: import('./board-config.js').FileApi }} options `directory` is where the state file lives */
export function seedingStore ({ directory, fs }) {
  const file = `${directory}/state.json`
  return {
    directory,
    /** @returns {SeedingState} what is kept, or a seeding that is off when there is nothing or it cannot be read */
    read () {
      try { return normalise(JSON.parse(fs.readFileSync(file, 'utf-8'))) } catch { return blank() }
    },
    /** @param {SeedingState} state */
    write (state) {
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
      fs.renameSync(`${file}.tmp`, file)
    }
  }
}

// Run once a day by share-copy-expire.timer: unpins from Orivon's Kubo node and Filebase account every copy
// whose month is over, and marks it. A pin that was there before the service saw it is never unpinned.
//   node expire.mjs <cid>...   the takedown of a share: ends the copy of each CID now, whatever its age, and
//                              blocks each CID (kept here or not), so it is not taken again
// Configuration: FILEBASE_KEY, STATE_DIR, FILEBASE_RPC, KUBO_RPC.

import { parseCid } from '../page/src/ipfs/cid.js'
import { rpc } from './backend.mjs'
import { addBlocked, blockedFile, due, markExpired, pinsFile, readBlocked, readPins } from './store.mjs'

const STATE_DIR = process.env.STATE_DIR ?? '/var/lib/share-copy'
const KEY = process.env.FILEBASE_KEY ?? ''
const kubo = rpc({ name: 'Orivon\'s node', base: process.env.KUBO_RPC ?? 'http://127.0.0.1:5001' })
const filebase = rpc({ name: 'Filebase', base: process.env.FILEBASE_RPC ?? 'https://rpc.filebase.io', key: KEY })

const named = process.argv.slice(2).map((text) => {
  try {
    return parseCid(text).string
  } catch {
    console.error(`[expire] ${text} is not an IPFS address`)
    process.exit(2)
  }
})
const file = pinsFile(STATE_DIR)
const pins = await readPins(file)
const ending = named.length === 0 ? due(pins, Date.now()) : named.map((cid) => pins.get(cid)).filter((pin) => pin !== undefined && !pin.expired)
if (ending.some((pin) => pin.filebase) && KEY === '') {
  console.error('[expire] FILEBASE_KEY is not set')
  process.exit(1)
}

let blocked = 0
if (named.length > 0) {
  const already = await readBlocked(blockedFile(STATE_DIR))
  for (const cid of new Set(named)) {
    if (already.has(cid)) continue
    await addBlocked(blockedFile(STATE_DIR), cid)
    blocked++
  }
}

let ended = 0
for (const pin of ending) {
  try {
    if (pin.kubo) await kubo.unpin(pin.cid)
    if (pin.filebase) await filebase.unpin(pin.cid)
    await markExpired(file, pin.cid)
    ended++
  } catch (error) {
    process.exitCode = 1
    console.error(`[expire] ${pin.cid} is tried again tomorrow: ${error instanceof Error ? error.message : String(error)}`)
  }
}
const stillKept = [...pins.values()].filter((pin) => !pin.expired).length - ended
console.log(`[expire] ${String(ended)} copy(ies) ended, ${String(stillKept)} still kept${named.length > 0 ? `, ${String(blocked)} CID(s) blocked` : ''}`)

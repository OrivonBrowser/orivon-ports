// Run once a day by decentrawiki-relay-expire.timer: unpins from Orivon's Filebase account every free pin
// whose month is over, and marks it, so the same version is not kept free a second time. A CID the account
// pinned before the relay saw it is never unpinned. Names are not touched by the daily run: the republisher
// (republish.mjs) ends a name when its month is over.
//   node expire.mjs <cid>...        the takedown of a wiki: ends the free pin of each CID now, whatever its age,
//                                   blocks each CID (pinned here or not), and ends every name that points at one
//   node expire.mjs --name <name>... ends those names now
// Configuration: FILEBASE_KEY (not needed to end names or to block a CID that is no free pin), STATE_DIR, FILEBASE_RPC.

import { parseCid } from '../page/src/ipfs/cid.js'
import { addBlocked, addEnded, checkedName, namesFile, readNames } from './names.mjs'
import { due, markExpired, pinsFile, readPins } from './store.mjs'

const STATE_DIR = process.env.STATE_DIR ?? '/var/lib/decentrawiki-relay'
const FILEBASE_RPC = (process.env.FILEBASE_RPC ?? 'https://rpc.filebase.io').replace(/\/+$/, '')
const KEY = process.env.FILEBASE_KEY ?? ''

const args = process.argv.slice(2)
const file = pinsFile(STATE_DIR)
const namesAt = namesFile(STATE_DIR)

if (args[0] === '--name') {
  const state = await readNames(namesAt)
  let ended = 0
  for (const text of args.slice(1)) {
    let name
    try {
      name = checkedName(text)
    } catch (error) {
      console.error(`[expire] ${text}: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
      continue
    }
    const kept = state.names.get(name)
    if (kept === undefined || kept.ended) {
      console.error(`[expire] ${name} is not a name this relay keeps`)
      process.exitCode = 1
      continue
    }
    await addEnded(namesAt, name)
    ended++
  }
  console.log(`[expire] ${String(ended)} name(s) ended`)
  process.exit(process.exitCode ?? 0)
}

const pins = await readPins(file)
const named = args.map((text) => {
  try {
    return parseCid(text).string
  } catch {
    return text
  }
})
const ending = named.length === 0
  ? due(pins, Date.now())
  : named.map((cid) => pins.get(cid)).filter((pin) => pin !== undefined && !pin.expired && !pin.preexisting)
if (named.length === 0 && KEY === '') {
  console.error('FILEBASE_KEY is not set')
  process.exit(1)
}

let blocked = 0
let namesEnded = 0
if (named.length > 0) {
  if (ending.length !== named.length) {
    console.error(`[expire] ${String(named.length - ending.length)} of the CIDs named are not live free pins, so nothing is unpinned for them; they are blocked all the same`)
  }
  const state = await readNames(namesAt)
  for (const cid of new Set(named)) {
    if (!state.blocked.has(cid)) {
      await addBlocked(namesAt, cid)
      blocked++
    }
    for (const kept of state.names.values()) {
      if (kept.cid === cid && !kept.ended) {
        await addEnded(namesAt, kept.name)
        kept.ended = true
        namesEnded++
      }
    }
  }
}

if (ending.length > 0 && KEY === '') {
  console.error('[expire] FILEBASE_KEY is not set, so the free pins are not unpinned; the CIDs and names above are ended all the same')
  process.exit(1)
}
let ended = 0
for (const pin of ending) {
  const response = await fetch(`${FILEBASE_RPC}/api/v0/pin/rm?arg=${pin.cid}`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(120_000) })
  const text = await response.text()
  // "not pinned" means someone already ended it: the month is over either way.
  if (response.ok || /not pinned/i.test(text)) {
    await markExpired(file, pin.cid)
    ended++
  } else {
    console.error(`[expire] Filebase answered ${response.status} for ${pin.cid}; it is tried again tomorrow`)
  }
}
const stillKept = [...pins.values()].filter((p) => !p.expired).length - ended
console.log(`[expire] ${String(ended)} free pin(s) ended, ${String(stillKept)} still kept${named.length > 0 ? `, ${String(blocked)} CID(s) blocked, ${String(namesEnded)} name(s) ended` : ''}`)

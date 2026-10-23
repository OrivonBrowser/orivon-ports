// Run once a day by decentrawiki-relay-expire.timer: unpins from Orivon's Filebase account every free pin
// whose month is over, and marks it, so the same version is not kept free a second time. A CID the account
// pinned before the relay saw it is never unpinned. Given CIDs as arguments, it ends those free pins now,
// whatever their age: the takedown of a wiki that should not be kept.
// Configuration: FILEBASE_KEY, STATE_DIR, FILEBASE_RPC.

import { due, markExpired, pinsFile, readPins } from './store.mjs'

const STATE_DIR = process.env.STATE_DIR ?? '/var/lib/decentrawiki-relay'
const FILEBASE_RPC = (process.env.FILEBASE_RPC ?? 'https://rpc.filebase.io').replace(/\/+$/, '')
const KEY = process.env.FILEBASE_KEY ?? ''

if (KEY === '') {
  console.error('FILEBASE_KEY is not set')
  process.exit(1)
}

const file = pinsFile(STATE_DIR)
const pins = await readPins(file)
const named = process.argv.slice(2)
const ending = named.length === 0
  ? due(pins, Date.now())
  : named.map((cid) => pins.get(cid)).filter((pin) => pin !== undefined && !pin.expired && !pin.preexisting)
if (named.length > 0 && ending.length !== named.length) console.error('[expire] only the live free pins among the CIDs named are ended; the others are not the relay\'s to end')
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
console.log(`[expire] ${String(ended)} free pin(s) ended, ${String([...pins.values()].filter((p) => !p.expired).length - ended)} still kept`)

// Run once a day by decentrawiki-relay-expire.timer: unpins from Orivon's Filebase account every free pin
// whose month is over, and marks it, so the same version is not kept free a second time. A CID the account
// pinned before the relay saw it is never unpinned. Configuration: FILEBASE_KEY, STATE_DIR, FILEBASE_RPC.

import { due, pinsFile, readPins, writePins } from './store.mjs'

const STATE_DIR = process.env.STATE_DIR ?? '/var/lib/decentrawiki-relay'
const FILEBASE_RPC = (process.env.FILEBASE_RPC ?? 'https://rpc.filebase.io').replace(/\/+$/, '')
const KEY = process.env.FILEBASE_KEY ?? ''

if (KEY === '') {
  console.error('FILEBASE_KEY is not set')
  process.exit(1)
}

const file = pinsFile(STATE_DIR)
const pins = await readPins(file)
let ended = 0
for (const pin of due(pins, Date.now())) {
  const response = await fetch(`${FILEBASE_RPC}/api/v0/pin/rm?arg=${pin.cid}`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(120_000) })
  const text = await response.text()
  // "not pinned" means someone already ended it: the month is over either way.
  if (response.ok || /not pinned/i.test(text)) {
    pins.set(pin.cid, { ...pin, expired: true })
    ended++
  } else {
    console.error(`[expire] Filebase answered ${response.status} for ${pin.cid}; it is tried again tomorrow`)
  }
}
if (ended > 0) await writePins(file, pins)
console.log(`[expire] ${String(ended)} free pin(s) ended, ${String([...pins.values()].filter((p) => !p.expired).length)} still kept`)

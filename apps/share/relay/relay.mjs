import { loadOrCreateKey } from './key.mjs'
import { createRelayNode } from './node.mjs'

// The environment the unit sets (share-relay.service); the defaults are the production values.
const STATE_DIR = process.env.STATE_DIR ?? './state'
const LISTEN = process.env.LISTEN ?? '/ip4/0.0.0.0/tcp/4003'
const ANNOUNCE = process.env.ANNOUNCE ?? '/ip4/152.228.138.30/tcp/4003'
const LOG_EVERY_MS = Number(process.env.LOG_EVERY_MS ?? 60 * 60 * 1000)

const split = (value) => value.split(',').map((part) => part.trim()).filter(Boolean)
// Anything libp2p raises may carry the address of the peer that caused it, so only the error's
// name goes to the journal.
const describe = (error) => `${error?.name ?? 'Error'}${error?.code == null ? '' : ` ${String(error.code)}`}`

let relay
let last = { reservations: 0, connections: 0, circuits: 0, bytes: 0 }

function logStats () {
  const now = relay.stats()
  console.log(`share-relay stats: reservations=${now.reservations} connections=${now.connections} circuits_since_last=${now.circuits - last.circuits} bytes_since_last=${now.bytes - last.bytes} circuits_total=${now.circuits} bytes_total=${now.bytes}`)
  last = now
}

async function stop () {
  if (relay != null) {
    logStats()
    await relay.stop()
  }
  process.exit(0)
}

// Installed before the node starts, so a stop asked for during the start is an orderly one.
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.on('unhandledRejection', (reason) => { console.error(`share-relay: unhandled rejection: ${describe(reason)}`) })
process.on('uncaughtException', (error) => {
  console.error(`share-relay: uncaught exception: ${describe(error)}`)
  process.exit(1)
})

relay = await createRelayNode({ privateKey: await loadOrCreateKey(STATE_DIR), listen: split(LISTEN), announce: split(ANNOUNCE) })
console.log(`share-relay started: ${relay.addresses().join(' ')}`)
setInterval(logStats, LOG_EVERY_MS).unref()

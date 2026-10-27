// Run every four hours by decentrawiki-relay-republish.timer: ends the names whose month is over, whose
// version was taken down or whose record ran out, and puts every other kept name back on the network through
// the Kubo node beside the relay (names.mjs). A put that fails is logged and tried again on the next run.
// Needs no pinning key. Configuration: KUBO_RPC, STATE_DIR.

import { kuboClient } from './from-node.mjs'
import { namesFile, republishNames } from './names.mjs'

const STATE_DIR = process.env.STATE_DIR ?? '/var/lib/decentrawiki-relay'
const kubo = kuboClient(process.env.KUBO_RPC ?? 'http://127.0.0.1:5001')

const { republished, failed, ended } = await republishNames({ kubo, file: namesFile(STATE_DIR) })
console.log(`[republish] republished ${String(republished)}, failed ${String(failed)}, ended ${String(ended)}`)
// Every put failing means Kubo is not answering: the unit shows as failed instead of looking healthy.
if (failed > 0 && republished === 0) process.exitCode = 1

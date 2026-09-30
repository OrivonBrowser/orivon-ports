// Stands in for `undici`, which the server reaches only through cheerio's
// `fromURL` (a fetch that upstream's own code never calls: link previews go
// through `got`). Bundled as it is, undici would pull in the modules a
// browser cannot give (`http2`, `async_hooks`, a WebAssembly HTTP parser)
// for a function nothing calls. Every entry point of undici's API throws.

import { refusing } from './refusal.js'

const why = 'only cheerio.fromURL reaches it, and the server never calls that; link previews use got'
const refuse = (name) => refusing(`undici.${name}`, why)

export const request = refuse('request')
export const stream = refuse('stream')
export const pipeline = refuse('pipeline')
export const connect = refuse('connect')
export const upgrade = refuse('upgrade')
export const fetch = refuse('fetch')
export const Agent = refuse('Agent')
export const Client = refuse('Client')
export const Pool = refuse('Pool')

export default { request, stream, pipeline, connect, upgrade, fetch, Agent, Client, Pool }

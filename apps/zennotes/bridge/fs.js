// Stands in for `node:fs` where upstream imports it: the shim's own `fs`, with `promises` paced
// (paced-fs.js). The stand-in's own import of `node:fs` is not caught by the stand-in (build-plan.js).

import * as real from 'node:fs'
import { pacedPromises } from './paced-instance.js'

export * from 'node:fs'
export const promises = pacedPromises

const base = real.default ?? real
export default new Proxy(base, { get: (target, name) => (name === 'promises' ? pacedPromises : target[name]) })

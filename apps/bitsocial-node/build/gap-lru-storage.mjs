// Workaround, deletable when the shim's SQLite locks a file or refuses a second connection to it: pkc-js's `LRUStorage` opens one
// database connection for each cache name (the name-resolution cache, the evm-contract challenge's wallet cache) on one file,
// `<dataPath>/lru-storage`. The shim's SQLite has no locking and each connection remembers the file's size from its first
// read (`src/shim/sqlite/README.md`: one connection uses a file at a time), so once the second cache has made its table the
// first connection's next write fails with "database disk image is malformed". Each cache name gets a file of its own, which
// keeps it one connection to one file. The old `lru-storage` is left where it is and no longer opened: a cache, and the new
// files start empty.

import { replaceOnce } from './text-patch.mjs'

const OLD_FILE = 'path.join(this._opts.pkc.dataPath, "lru-storage")'
// A cache name is the SQL name of a table (pkc-js writes it unquoted), so it is made of word characters; the replace is a guard.
const NEW_FILE = 'path.join(this._opts.pkc.dataPath, "lru-storage-" + String(this._opts.cacheName).replace(/[^\\w.-]/g, "_"))'

/** @type {import('./text-patch.mjs').Patch} */
export const lruStorageFiles = {
  name: 'two SQLite connections to one file corrupt it in the shim: each LRUStorage cache has its own file',
  file: /@pkcprotocol[\\/]pkc-js[\\/]dist[\\/]bundled[\\/]chunks[\\/]node-[\w-]+\.js$/,
  apply: replaceOnce(OLD_FILE, NEW_FILE)
}

// Stands in for `node:fs/promises` where upstream imports it: the same paced calls `fs.promises` has.

import { pacedPromises } from './paced-instance.js'

export * from 'node:fs/promises'
export const {
  open, access, chmod, lchmod, readFile, writeFile, appendFile, rename, unlink, rmdir, realpath, mkdir, readdir, stat, lstat, rm,
  copyFile, cp, mkdtemp
} = pacedPromises
export default pacedPromises

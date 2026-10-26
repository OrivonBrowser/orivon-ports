// The one paced `fs.promises` every upstream module shares, so they share one queue and one memory.

import { promises } from 'node:fs'
import { pace } from './paced-fs.js'

export const pacedPromises = pace(promises, {
  onError: (name, path, error) => { console.warn(`ZenNotes: fs.${name} failed for ${path}:`, error?.message ?? error) }
})

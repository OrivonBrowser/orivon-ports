import { LIMITS } from '../model.js'

// A dropped folder arrives as directory entries, not files, so it is walked here.
// File.webkitRelativePath is read-only on the prototype but an own property can
// carry the same value, which is all the core reads.

function readBatch (reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject))
}

function entryFile (entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

async function walk (entry, found) {
  if (found.length > LIMITS.maxFiles) return
  if (entry.isFile) {
    const file = await entryFile(entry)
    Object.defineProperty(file, 'webkitRelativePath', { value: entry.fullPath.replace(/^\//, ''), configurable: true })
    found.push(file)
    return
  }
  const reader = entry.createReader()
  for (let batch = await readBatch(reader); batch.length > 0; batch = await readBatch(reader)) {
    await Promise.all(batch.map((child) => walk(child, found)))
    if (found.length > LIMITS.maxFiles) return
  }
}

/**
 * The files in a drop. `directory` asks for one dropped folder; otherwise
 * loose files, with any dropped folder skipped. The data transfer is read
 * before the first await because it is emptied once the event returns.
 */
export async function collectDropped (dataTransfer, directory) {
  const items = Array.from(dataTransfer.items || []).filter((item) => item.kind === 'file')
  const picked = items.map((item) => ({
    file: item.getAsFile(),
    entry: typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
  }))
  if (items.length === 0) return Array.from(dataTransfer.files || [])

  if (directory) {
    const folder = picked.find((item) => item.entry && item.entry.isDirectory)
    if (!folder) return []
    const found = []
    await walk(folder.entry, found)
    return found
  }
  return picked.filter((item) => item.file && !(item.entry && item.entry.isDirectory)).map((item) => item.file)
}

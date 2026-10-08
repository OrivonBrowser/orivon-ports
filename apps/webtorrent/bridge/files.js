// Files crossing between the person's computer and the app's own files, the
// two ways Orivon allows: a file the person picks or drops is copied in, and a
// file the app holds is copied out to a folder the person picks. Upstream's
// main process handed its windows host paths instead; a host path never
// exists here, so every path these return names a file in the app's files.

import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** Where a picked file is copied: one folder per pick, so two picks of the same name never collide. */
export const IMPORT_ROOT = '/orivon/app/Imported'

const CHUNK = 1 << 20

/** Shows the page's own file picker and resolves the Files chosen, or [] when the person cancels. Call it inside a click. */
export function pickFiles ({ accept = '', multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = multiple
    if (accept !== '') input.accept = accept
    input.addEventListener('change', () => { resolve([...(input.files ?? [])]) }, { once: true })
    input.addEventListener('cancel', () => { resolve([]) }, { once: true })
    input.click()
  })
}

/** A new folder under IMPORT_ROOT for one pick or one drop. */
async function importFolder () {
  const folder = join(IMPORT_ROOT, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(folder, { recursive: true })
  return folder
}

async function copyIn (file, target) {
  const handle = await open(target, 'w')
  try {
    for (let at = 0; at < file.size; at += CHUNK) {
      await handle.write(new Uint8Array(await file.slice(at, at + CHUNK).arrayBuffer()), 0, undefined, at)
    }
  } finally {
    await handle.close()
  }
}

/** Copies each File into one new folder under IMPORT_ROOT and resolves their paths, in order. */
export async function importFiles (files) {
  const folder = await importFolder()
  const paths = []
  for (const file of files) {
    const target = join(folder, basename(file.name))
    await copyIn(file, target)
    paths.push(target)
  }
  return paths
}

/** Copies what was dropped (files and whole folders, as `webkitGetAsEntry` gives them) into one new folder, and resolves a path for each. */
export async function importEntries (entries) {
  const folder = await importFolder()
  const paths = []
  for (const entry of entries) {
    await copyEntry(entry, join(folder, entry.name))
    paths.push(join(folder, entry.name))
  }
  return paths
}

async function copyEntry (entry, target) {
  if (entry.isFile) {
    await copyIn(await new Promise((resolve, reject) => { entry.file(resolve, reject) }), target)
    return
  }
  await mkdir(target, { recursive: true })
  const reader = entry.createReader()
  for (;;) {
    const batch = await new Promise((resolve, reject) => { reader.readEntries(resolve, reject) })
    if (batch.length === 0) return
    for (const child of batch) await copyEntry(child, join(target, child.name))
  }
}

/** Copies a file or a folder of the app's into a folder the person picks; resolves false when they cancel. Call it inside a click. */
export async function exportPath (path) {
  const target = await globalThis.orivon.fs.userSelected({ directory: true })
  if (target === null) return false
  try {
    await copyOut(path, basename(path), target)
  } finally {
    await target.close()
  }
  return true
}

async function copyOut (from, name, target) {
  if ((await stat(from)).isDirectory()) {
    await target.mkdir(name, { recursive: true })
    for (const entry of await readdir(from)) await copyOut(join(from, entry), `${name}/${entry}`, target)
    return
  }
  const out = await target.open(name, 'w')
  try {
    let at = 0
    for await (const chunk of createReadStream(from, { highWaterMark: CHUNK })) {
      await out.write({ position: at, data: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) })
      at += chunk.byteLength
    }
  } finally {
    await out.close()
  }
}

/** Hands `bytes` to the person as a download named `name`, the way a web page saves a file it made. */
export function offerDownload (name, bytes) {
  const url = URL.createObjectURL(new Blob([bytes]))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => { URL.revokeObjectURL(url) }, 60_000)
}


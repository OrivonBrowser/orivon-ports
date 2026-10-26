// Shows the images, audio and video a note embeds. Upstream's preload turns a note's `![](a.png)`
// into `zen-asset://local?path=<file>`, an address only the desktop program's own URL scheme
// answers. In a tab the path in it is a stand-in path that `fs` reads (the folder the person
// picked), so each such element gets a `blob:` address of the same bytes in its place, as soon as
// it is in the page.

import { pacedPromises as fs } from './paced-instance.js'

const PREFIX = 'zen-asset://local?path='

const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg',
  m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', pdf: 'application/pdf'
}

/** The file a `zen-asset://local?path=` address names, or null for any other address. */
export function assetPath (address) {
  if (typeof address !== 'string' || !address.startsWith(PREFIX)) return null
  try {
    return decodeURIComponent(address.slice(PREFIX.length))
  } catch {
    return null
  }
}

/** The media type of a file from its extension, `application/octet-stream` when the extension is not one a note embeds. */
export function typeOf (path) {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase()
  return (extension === undefined ? undefined : TYPES[extension]) ?? 'application/octet-stream'
}

/**
 * Replaces every `zen-asset://` address in `root`, now and as elements arrive or change, with a
 * `blob:` address of the file's bytes. A file is read once per page: an element that names it again
 * gets the same address. A file that cannot be read keeps its address and says why in the console.
 */
export function watchAssets ({ root, read = (path) => fs.readFile(path), createUrl = (blob) => URL.createObjectURL(blob), observe = true }) {
  const made = new Map()

  async function show (element) {
    const path = assetPath(element.getAttribute('src'))
    if (path === null) return
    try {
      if (!made.has(path)) made.set(path, read(path).then((bytes) => createUrl(new Blob([bytes], { type: typeOf(path) }))))
      const url = await made.get(path)
      if (assetPath(element.getAttribute('src')) === path) element.setAttribute('src', url)
    } catch (error) {
      made.delete(path)
      console.warn(`ZenNotes: could not read ${path} for a note:`, error)
    }
  }

  const sweep = (scope) => {
    for (const element of scope.querySelectorAll?.('[src^="zen-asset:"]') ?? []) void show(element)
    if (scope.getAttribute?.('src')?.startsWith('zen-asset:')) void show(scope)
  }

  sweep(root)
  if (!observe) return () => {}
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') void show(record.target)
      for (const node of record.addedNodes) if (node.nodeType === 1) sweep(node)
    }
  })
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] })
  return () => { observer.disconnect() }
}

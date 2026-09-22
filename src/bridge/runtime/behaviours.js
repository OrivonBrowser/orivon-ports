// The behaviours a port declares by name: members whose implementation is the
// same everywhere and whose NAME is each app's own invention. The catalog of
// what exists, and what each one installs, is ../catalog.ts -- a test holds
// the two in step.
//
// Not a module. Spliced verbatim into the composed bridge after preamble.js,
// so `BridgeError` and `getOrivon` below are that file's. Each factory takes
// the global it is installing onto, so a refusal names the object the app
// actually called.

const BEHAVIOURS = {
  fullscreen: ({ member }) => ({
    // Not awaited at every call site (a deep link can fire it outside a user
    // gesture), so an unhandled rejection would be blamed on the wrong caller.
    [member]: () => {
      const result = document.documentElement.requestFullscreen()
      result.catch(() => {})
      return result
    }
  }),

  pictureInPicture: ({ member }) => ({
    [member]: () => {
      const video = document.querySelector('video')
      if (video === null) return Promise.resolve()
      const result = video.requestPictureInPicture()
      result.catch(() => {})
      return result
    }
  }),

  zoom: ({ member }) => ({
    [member]: (factor) => { document.documentElement.style.zoom = String(factor) }
  }),

  locale: ({ member }) => ({
    [member]: () => navigator.language
  }),

  wakeLock: ({ acquire, release }) => {
    let held
    return {
      [acquire]: async () => {
        if (!('wakeLock' in navigator)) return
        try { held = await navigator.wakeLock.request('screen') } catch { /* denied or unsupported */ }
      },
      [release]: async () => {
        const sentinel = held
        held = undefined
        await sentinel?.release()
      }
    }
  },

  memoryCache: ({ get, set }) => {
    const cache = new Map()
    return {
      [get]: async (key) => cache.get(key),
      [set]: async (key, value) => { cache.set(key, value) }
    }
  },

  // The one route out of the app's own directory. The picked folder IS the
  // consent, so there is no separate grant to ask for -- and the handle never
  // leaves this closure: the app passes a filename and bytes, and gets back a
  // boolean. A member that returned a path instead could not be written this
  // way at all (docs/porting-guide.md, the escape test).
  pickedFolderDownloads: ({ choose, write }, owner) => {
    let folder = null
    return {
      [choose]: async () => {
        const fs = getOrivon()?.fs
        if (fs === undefined) throw new BridgeError(choose, 'not-built', 'no fs grant', owner)
        folder = await fs.userSelected({ directory: true })
      },
      [write]: async (name, bytes) => {
        if (folder === null || folder === undefined) return false
        await folder.writeFile(name, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
        return true
      }
    }
  }
}

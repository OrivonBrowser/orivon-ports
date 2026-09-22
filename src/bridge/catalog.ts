// What a behaviour is, and which ones exist. A behaviour is a member whose
// implementation is the same in every port and whose NAME is not: the browser
// already does the thing, so only the app's own spelling of it differs.
//
// A behaviour enters this table because a real port needs it, never because a
// future one might -- see README.md's Design notes.

export interface BehaviourSpec {
  /** The members this behaviour installs. A one-member behaviour uses the single role `member`, and its declaration may name it with a bare string. */
  readonly roles: readonly string[]
  /** What it does, in the words a reader of the generated bridge needs. Emitted above the group. */
  readonly summary: string
  /** The capability it reaches for, when it reaches for one. A behaviour without this touches nothing but the page. */
  readonly needs?: string
}

export const CATALOG: Readonly<Record<string, BehaviourSpec>> = {
  fullscreen: { roles: ['member'], summary: 'document.documentElement.requestFullscreen()' },
  pictureInPicture: { roles: ['member'], summary: "the page's first <video>, into picture-in-picture" },
  zoom: { roles: ['member'], summary: 'document.documentElement.style.zoom' },
  locale: { roles: ['member'], summary: 'navigator.language' },
  wakeLock: { roles: ['acquire', 'release'], summary: 'navigator.wakeLock, held between the two members' },
  memoryCache: { roles: ['get', 'set'], summary: 'a Map that lives exactly as long as the page' },
  pickedFolderDownloads: {
    roles: ['choose', 'write'],
    summary: 'a folder the user picked, written to by filename -- the handle never reaches app code',
    needs: 'orivon.fs'
  }
}

export const BEHAVIOUR_IDS: readonly string[] = Object.keys(CATALOG).sort()

export const SINGLE_ROLE = 'member'

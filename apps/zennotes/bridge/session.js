// The part of upstream's main process that remembers which vault is open, as plain functions the
// tests can run without upstream's source. Upstream keeps the open vault per window and the
// remembered vaults in its settings file, by path. A path the page was given for a folder lasts
// until the page reloads (orivon-mvp: a picked folder is not re-attached without the picker), so
// this keeps the vaults opened since the page loaded, in memory, and nothing about them on disk.

const PICKED = /^\/orivon\/picked\/[0-9a-f]+\/?$/

/** What a vault with no name of its own (no display name in its settings) is called: the folder dialog gives the page no name for the folder. */
export const UNNAMED = 'Notes folder'

/**
 * @param {{ ensureVaultLayout: (root: string) => Promise<void>, describeVault: (root: string) => Promise<{ root: string, name: string }>, now?: () => number }} deps
 */
export function createSession ({ ensureVaultLayout, describeVault: describe, now = Date.now }) {
  /** Upstream names a vault after its folder; a picked folder's path ends in the pick's own id, which names nothing a person knows. */
  async function describeVault (root) {
    const info = await describe(root)
    return info.name === root.split('/').pop() && PICKED.test(root) ? { ...info, name: UNNAMED } : info
  }

  /** @type {{ root: string, name: string } | null} */
  let current = null
  /** @type {Map<string, { root: string, name: string, lastOpenedAt: number }>} */
  const opened = new Map()

  function remember (info) {
    opened.delete(info.root)
    opened.set(info.root, { ...info, lastOpenedAt: now() })
    current = info
    return info
  }

  return {
    /** The vault the page works in, or throws what upstream's handlers throw when none is open. */
    require () {
      if (current === null) throw new Error('No vault is open')
      return current
    },

    /** The open vault, its name read again (a rename made in another program shows), or null. */
    async current () {
      if (current === null) return null
      return remember(await describeVault(current.root))
    },

    /** Opens a folder as a vault: upstream's layout (the folders it expects, a first note in an empty one), then the vault's description. */
    async open (root) {
      await ensureVaultLayout(root)
      return remember(await describeVault(root))
    },

    /** The vaults opened since the page loaded, most recent first, as upstream's switcher lists them. */
    list () {
      return [...opened.values()].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    },

    /** Makes an already opened vault the current one; null for a root this page never opened. */
    async switchTo (root) {
      if (!opened.has(root)) return null
      return remember(await describeVault(root))
    },

    /** Forgets the current vault and moves to the one opened before it, as upstream does; null when there is none. */
    async close () {
      if (current === null) return null
      opened.delete(current.root)
      current = null
      const [next] = this.list()
      return next === undefined ? null : await this.switchTo(next.root)
    }
  }
}

/** Upstream's list-notes stream: the list is made once per request id and handed out in chunks. */
export function createNoteStream ({ listNotes, now = Date.now, ttlMs = 60_000 }) {
  const states = new Map()

  function prune () {
    const cutoff = now() - ttlMs
    for (const [id, state] of states) if (state.touchedAt < cutoff) states.delete(id)
  }

  return async function page (root, request) {
    if (typeof request?.requestId !== 'string' || request.requestId.length === 0) throw new Error('Missing list-notes stream request id')
    const chunk = Number.isInteger(request.chunkSize) && request.chunkSize > 0 ? Math.min(request.chunkSize, 1000) : 500
    const offset = Number.isInteger(request.offset) && request.offset > 0 ? request.offset : 0
    prune()
    let state = states.get(request.requestId)
    if (state === undefined || offset === 0) {
      state = { notes: await listNotes(root), touchedAt: now() }
      states.set(request.requestId, state)
    } else {
      state.touchedAt = now()
    }
    const nextOffset = Math.min(state.notes.length, offset + chunk)
    const done = nextOffset >= state.notes.length
    const notes = state.notes.slice(offset, nextOffset)
    if (done) states.delete(request.requestId)
    return { notes, nextOffset, done, total: state.notes.length }
  }
}

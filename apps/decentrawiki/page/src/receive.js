// The editor's half of a published wiki's pen ($:/plugins/orivon/decentrawiki/handoff.js).
// The wiki arrives in the address itself when it was small enough, else from
// the page that opened this one, which answers a "ready" message with it.

import { HANDOFF_FORMAT, ImportError } from './import.js'

const WAIT_MS = 15000
const ASK_EVERY_MS = 400

/** @typedef {{ format: string, version: number, source: { url: string, origin: string, title: string }, focus: { title: string, edit: boolean } | null, tiddlers: unknown[] }} Handoff */

/** @param {string} text */
function fromBase64url (text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** @param {unknown} value @returns {Handoff} */
export function checkHandoff (value) {
  const payload = /** @type {any} */ (value)
  if (payload === null || typeof payload !== 'object' || payload.format !== HANDOFF_FORMAT || payload.version !== 1 || !Array.isArray(payload.tiddlers)) {
    throw new ImportError('unreadable', 'What the wiki handed over is not a DecentraWiki wiki.')
  }
  const source = payload.source ?? {}
  const focus = payload.focus
  return {
    format: HANDOFF_FORMAT,
    version: 1,
    source: { url: String(source.url ?? '').slice(0, 2000), origin: String(source.origin ?? '').slice(0, 300), title: String(source.title ?? '').slice(0, 200) },
    focus: focus !== null && typeof focus === 'object' && typeof focus.title === 'string' ? { title: focus.title.slice(0, 500), edit: focus.edit === true } : null,
    tiddlers: payload.tiddlers
  }
}

/** The copy carried in the address. @param {string} inline @returns {Promise<Handoff>} */
export async function decodeInline (inline) {
  try {
    const stream = new Blob([fromBase64url(inline)]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
    return checkHandoff(JSON.parse(await new Response(stream).text()))
  } catch (error) {
    if (error instanceof ImportError) throw error
    throw new ImportError('unreadable', 'The wiki in this address is damaged or cut short. Go back to it and press Edit again.')
  }
}

/**
 * Asks the page that opened this one for its wiki.
 * @param {string} nonce
 * @returns {Promise<Handoff>}
 */
export function askOpener (nonce) {
  const opener = window.opener
  if (opener === null) {
    return Promise.reject(new ImportError('unreadable', 'This wiki is too large to hand over through the address, and this tab has no link back to the page that sent it. On the wiki page, choose download a copy in its sidebar, then import the file here.'))
  }
  return new Promise((resolve, reject) => {
    const ask = () => opener.postMessage({ protocol: HANDOFF_FORMAT, type: 'ready', nonce }, '*')
    const timer = setInterval(ask, ASK_EVERY_MS)
    const deadline = setTimeout(() => finish(new ImportError('unreadable', 'The wiki page did not send its wiki. Go back to it, reload it and press Edit again.')), WAIT_MS)
    /** @param {MessageEvent} event */
    const onMessage = (event) => {
      const data = event.data
      if (event.source !== opener || data === null || typeof data !== 'object' || data.protocol !== HANDOFF_FORMAT || data.nonce !== nonce || data.type !== 'wiki') return
      try {
        const payload = checkHandoff(data.payload)
        opener.postMessage({ protocol: HANDOFF_FORMAT, type: 'received', nonce }, event.origin)
        finish(null, payload)
      } catch (error) {
        finish(/** @type {Error} */ (error))
      }
    }
    /** @param {Error | null} error @param {Handoff} [payload] */
    function finish (error, payload) {
      clearInterval(timer)
      clearTimeout(deadline)
      window.removeEventListener('message', onMessage)
      if (error !== null) reject(error)
      else resolve(/** @type {Handoff} */ (payload))
    }
    window.addEventListener('message', onMessage)
    ask()
  })
}

/**
 * Reads `#/receive/<nonce>[/<inline>]`, then takes the copy out of the address
 * so a long address never lingers in the tab, its history or a restored session.
 * @param {string} hash
 * @returns {Promise<Handoff>}
 */
export async function receive (hash) {
  const [, nonce = '', inline = ''] = hash.replace(/^#\/receive\/?/, '/').split('/')
  history.replaceState(null, '', '#/receive')
  if (inline !== '') {
    const payload = await decodeInline(inline)
    if (window.opener !== null) window.opener.postMessage({ protocol: HANDOFF_FORMAT, type: 'received', nonce }, '*')
    return payload
  }
  return await askOpener(nonce)
}

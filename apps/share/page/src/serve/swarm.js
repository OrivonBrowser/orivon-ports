// A share's swarm: the introductions through the trackers and the connections they lead to. A seeder announces that
// it has the share and answers every offer it is sent; a leecher announces offers of its own and finishes the
// connection when an answer comes. What a connection is used for is up to the caller: `onLink` gets each open link.

import { acceptOffer, makeOffer } from './rtc.js'
import { createLink } from './wire.js'
import { randomOfferId } from './ids.js'

/** How many offers a leecher makes for each tracker, and how long an unanswered one is kept. */
const OFFERS_PER_TRACKER = 3
const OFFER_TTL_MS = 90_000

/**
 * @typedef {ReturnType<typeof createLink>} Link
 * @typedef {object} SwarmOptions
 * @property {ReturnType<typeof import('./tracker.js').createTrackerHub>} hub
 * @property {string} infoHash the swarm, as a binary string
 * @property {'seed' | 'leech'} role
 * @property {(link: Link) => void} onLink an open link, with its wire protocol running
 * @property {() => boolean} [canAccept] whether a seeder takes one more peer
 * @property {import('./wire.js').LinkHandlers} [linkHandlers] what a link does with a request (a seeder's answer)
 * @property {import('./rtc.js').RtcOptions} [rtc]
 */

/** @param {SwarmOptions} options */
export function joinSwarm ({ hub, infoHash, role, onLink, canAccept = () => true, linkHandlers = {}, rtc = {} }) {
  /** @type {Map<string, { connect: (answer: { type: 'answer', sdp: string }) => Promise<RTCDataChannel>, close: () => void, at: number }>} */
  const offered = new Map()
  const started = new Set()
  let left = false

  /**
   * The one connection to each page, by the peer id the tracker names: a page makes several offers, through several
   * trackers, and every one that was answered must not become another peer.
   * @type {Map<string, ReturnType<typeof createLink> | 'pending'>}
   */
  const byPeer = new Map()

  /** @param {RTCDataChannel} channel @param {string} peerId */
  function attach (channel, peerId) {
    const existing = byPeer.get(peerId)
    const link = createLink(/** @type {any} */ (channel), {
      ...linkHandlers,
      onClose: () => {
        if (byPeer.get(peerId) === link) byPeer.delete(peerId)
        linkHandlers.onClose?.()
      }
    })
    if (existing !== undefined && existing !== 'pending' && existing.open) {
      link.close()
      return
    }
    byPeer.set(peerId, link)
    onLink(link)
  }

  /** @param {string} peerId */
  const forget = (peerId) => { if (byPeer.get(peerId) === 'pending') byPeer.delete(peerId) }

  const leave = hub.join(infoHash, {
    onAnnounce (send, url) {
      const event = started.has(url) ? {} : /** @type {const} */ ({ event: 'started' })
      started.add(url)
      if (role === 'seed') {
        send({ ...event, left: 0, numwant: 0, offers: [] })
        return
      }
      for (const [id, entry] of offered) if (Date.now() - entry.at > OFFER_TTL_MS) { entry.close(); offered.delete(id) }
      Promise.all(Array.from({ length: OFFERS_PER_TRACKER }, async () => {
        const made = await makeOffer(rtc)
        const id = randomOfferId()
        offered.set(id, { connect: made.connect, close: made.close, at: Date.now() })
        return { offer_id: id, offer: made.offer }
      })).then((offers) => { if (!left) send({ ...event, left: 1, numwant: offers.length, offers }) }, () => {})
    },

    onOffer ({ peerId, offer, reply }) {
      if (role !== 'seed' || left || byPeer.has(peerId) || !canAccept()) return
      byPeer.set(peerId, 'pending')
      acceptOffer(offer, rtc).then(({ answer, channel }) => {
        reply(answer)
        return channel.then((open) => attach(open, peerId))
      }).catch(() => forget(peerId))
    },

    onAnswer ({ peerId, offerId, answer }) {
      const entry = offered.get(offerId)
      if (role !== 'leech' || entry === undefined) return
      offered.delete(offerId)
      if (byPeer.has(peerId)) {
        entry.close()
        return
      }
      byPeer.set(peerId, 'pending')
      entry.connect(answer).then((open) => attach(open, peerId), () => forget(peerId))
    }
  })

  return {
    /** Announces again at once; a leecher with no peers does this while it waits. */
    refresh () { hub.announceNow(infoHash) },
    leave () {
      left = true
      leave()
      for (const entry of offered.values()) entry.close()
      offered.clear()
    }
  }
}

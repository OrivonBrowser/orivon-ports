// A WebTorrent tracker client, the part of the tracker protocol that WebRTC introductions need, over WebSocket:
// `announce` carries a peer's offers to the tracker, which hands each to another peer of the same swarm; that peer
// answers through the tracker with `to_peer_id`, and the two are connected directly. One socket per tracker serves
// every swarm this page is in. A tracker that drops is called again after a wait that doubles to a minute.

/** WebTorrent's public WSS trackers, all asked at once. They see the swarm hash and IP addresses, never an address or a byte. */
export const TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.files.fm:7073/announce'
]

const MAX_MESSAGE_CHARS = 64 * 1024
const MAX_SDP_CHARS = 16 * 1024
const FIRST_WAIT_MS = 1000
const MAX_WAIT_MS = 60_000
/** A connection that lasted this long was a good one: the next wait starts again from the first. */
const STABLE_MS = 30_000
export const DEFAULT_INTERVAL_S = 120
const MIN_INTERVAL_S = 30
const MAX_INTERVAL_S = 600

/**
 * @typedef {{ offer_id: string, offer: { type: 'offer', sdp: string } }} Offer
 * @typedef {{ event?: 'started' | 'stopped' | 'completed', left: number, numwant: number, offers: Offer[], uploaded?: number, downloaded?: number }} Announce
 * @typedef {object} Member
 * @property {(send: (params: Announce) => void, url: string) => void} onAnnounce a tracker is open, or its interval has run out: announce
 * @property {(offer: { peerId: string, offerId: string, offer: { type: 'offer', sdp: string }, reply: (answer: { type: 'answer', sdp: string }) => void }) => void} onOffer
 * @property {(answer: { peerId: string, offerId: string, answer: { type: 'answer', sdp: string } }) => void} onAnswer
 * @typedef {object} HubOptions
 * @property {string[]} [urls]
 * @property {string} peerId 20 characters, one per byte
 * @property {typeof WebSocket} [WebSocketImpl]
 * @property {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} [timers]
 */

/** @param {unknown} value */
const isSdp = (value) => typeof value === 'object' && value !== null && typeof /** @type {any} */ (value).sdp === 'string' && /** @type {any} */ (value).sdp.length <= MAX_SDP_CHARS

/** @param {HubOptions} options */
export function createTrackerHub ({
  urls = TRACKERS, peerId, WebSocketImpl = globalThis.WebSocket,
  // Called through these two, never as methods of this object: a browser refuses `setTimeout` with another `this`.
  timers = { setTimeout: (...args) => setTimeout(...args), clearTimeout: (...args) => clearTimeout(...args) }
}) {
  /** @type {Map<string, Member>} */
  const members = new Map()
  /** @type {Map<string, { socket: WebSocket | null, open: boolean, wait: number, since: number, retry: ReturnType<typeof setTimeout> | null, timers: Map<string, ReturnType<typeof setTimeout>> }>} */
  const trackers = new Map()
  let closed = false

  /** @param {string} url @param {object} message */
  const send = (url, message) => {
    const tracker = trackers.get(url)
    if (tracker?.open === true && tracker.socket !== null) tracker.socket.send(JSON.stringify(message))
  }

  /** @param {string} url @param {string} infoHash */
  function announceTo (url, infoHash) {
    const member = members.get(infoHash)
    if (member === undefined) return
    member.onAnnounce((params) => send(url, { action: 'announce', info_hash: infoHash, peer_id: peerId, uploaded: 0, downloaded: 0, ...params }), url)
    schedule(url, infoHash, DEFAULT_INTERVAL_S)
  }

  /** @param {string} url @param {string} infoHash @param {number} seconds */
  function schedule (url, infoHash, seconds) {
    const tracker = trackers.get(url)
    if (tracker === undefined || closed) return
    const previous = tracker.timers.get(infoHash)
    if (previous !== undefined) timers.clearTimeout(previous)
    const wait = Math.min(Math.max(seconds, MIN_INTERVAL_S), MAX_INTERVAL_S)
    tracker.timers.set(infoHash, timers.setTimeout(() => announceTo(url, infoHash), wait * 1000))
  }

  /** @param {string} url @param {any} data */
  function onMessage (url, data) {
    if (typeof data !== 'object' || data === null) return
    const infoHash = data.info_hash
    const member = typeof infoHash === 'string' ? members.get(infoHash) : undefined
    if (member === undefined || typeof infoHash !== 'string') return
    if (typeof data['failure reason'] === 'string') return
    if (data.peer_id === peerId) return
    if (typeof data.interval === 'number' && Number.isFinite(data.interval)) schedule(url, infoHash, data.interval)
    if (typeof data.peer_id !== 'string' || typeof data.offer_id !== 'string') return
    if (data.offer !== undefined && isSdp(data.offer) && data.offer.type === 'offer') {
      const toPeer = data.peer_id
      const offerId = data.offer_id
      member.onOffer({
        peerId: toPeer,
        offerId,
        offer: { type: 'offer', sdp: data.offer.sdp },
        reply: (answer) => send(url, { action: 'announce', info_hash: infoHash, peer_id: peerId, to_peer_id: toPeer, answer, offer_id: offerId })
      })
    } else if (data.answer !== undefined && isSdp(data.answer) && data.answer.type === 'answer') {
      member.onAnswer({ peerId: data.peer_id, offerId: data.offer_id, answer: { type: 'answer', sdp: data.answer.sdp } })
    }
  }

  /** @param {string} url */
  function connect (url) {
    const tracker = /** @type {NonNullable<ReturnType<typeof trackers.get>>} */ (trackers.get(url))
    if (closed) return
    let socket
    try {
      socket = new WebSocketImpl(url)
    } catch {
      retry(url)
      return
    }
    tracker.socket = socket
    socket.onopen = () => {
      tracker.open = true
      tracker.since = Date.now()
      for (const infoHash of members.keys()) announceTo(url, infoHash)
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string' || event.data.length > MAX_MESSAGE_CHARS) return
      try {
        onMessage(url, JSON.parse(event.data))
      } catch {
        // A message that is not JSON is ignored.
      }
    }
    const lost = () => {
      if (tracker.socket !== socket) return
      if (Date.now() - tracker.since >= STABLE_MS) tracker.wait = FIRST_WAIT_MS
      tracker.open = false
      tracker.socket = null
      for (const timer of tracker.timers.values()) timers.clearTimeout(timer)
      tracker.timers.clear()
      retry(url)
    }
    socket.onclose = lost
    socket.onerror = () => { try { socket.close() } catch { /* already closed */ } lost() }
  }

  /** @param {string} url */
  function retry (url) {
    const tracker = trackers.get(url)
    if (tracker === undefined || closed) return
    const wait = tracker.wait
    tracker.wait = Math.min(wait * 2, MAX_WAIT_MS)
    tracker.retry = timers.setTimeout(() => { tracker.retry = null; connect(url) }, wait * (0.8 + Math.random() * 0.4))
  }

  for (const url of urls) trackers.set(url, { socket: null, open: false, wait: FIRST_WAIT_MS, since: 0, retry: null, timers: new Map() })

  return {
    peerId,
    /** Opens the sockets, once. */
    start () {
      for (const url of urls) if (trackers.get(url)?.socket === null && trackers.get(url)?.retry === null) connect(url)
    },
    /**
     * Joins a swarm. Returns a function that leaves it, telling the trackers with `stopped`.
     * @param {string} infoHash 20 characters, one per byte @param {Member} member
     */
    join (infoHash, member) {
      members.set(infoHash, member)
      for (const [url, tracker] of trackers) if (tracker.open) announceTo(url, infoHash)
      return () => {
        members.delete(infoHash)
        for (const [url, tracker] of trackers) {
          const timer = tracker.timers.get(infoHash)
          if (timer !== undefined) timers.clearTimeout(timer)
          tracker.timers.delete(infoHash)
          send(url, { action: 'announce', info_hash: infoHash, peer_id: peerId, event: 'stopped', left: 0, numwant: 0, uploaded: 0, downloaded: 0 })
        }
      }
    },
    /** Announces a swarm to every open tracker now, ahead of its interval. @param {string} infoHash */
    announceNow (infoHash) {
      for (const [url, tracker] of trackers) if (tracker.open) announceTo(url, infoHash)
    },
    get state () {
      return { connected: [...trackers.values()].filter((tracker) => tracker.open).length, total: trackers.size }
    },
    close () {
      closed = true
      for (const tracker of trackers.values()) {
        if (tracker.retry !== null) timers.clearTimeout(tracker.retry)
        for (const timer of tracker.timers.values()) timers.clearTimeout(timer)
        try { tracker.socket?.close() } catch { /* already closed */ }
        tracker.open = false
        tracker.socket = null
      }
    }
  }
}

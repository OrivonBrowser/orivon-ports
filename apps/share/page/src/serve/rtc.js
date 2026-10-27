// WebRTC for one introduction. An offer is made with all of its ICE candidates in it (the tracker protocol has no
// way to send them later), so the page waits for gathering to end, up to a few seconds. STUN finds the address a
// router shows the world; there is no relay, so two peers behind routers that both refuse hole punching do not
// connect, and the person is told so rather than sent through a server that is not theirs.

/** STUN only. Address discovery, nothing carried. */
export const ICE_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' }
]
export const CHANNEL_LABEL = 'orivon-share/1'
const GATHER_MS = 4000
/** How long a connection may take to open its channel after the answer arrives. */
export const OPEN_MS = 20_000

/**
 * @typedef {object} RtcOptions
 * @property {typeof RTCPeerConnection} [RTCPeerConnectionImpl]
 * @property {RTCIceServer[]} [iceServers]
 * @property {number} [gatherMs]
 */

/** @param {RTCPeerConnection} pc @param {number} limitMs */
function gathered (pc, limitMs) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve(undefined)
    const timer = setTimeout(done, limitMs)
    function done () {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', check)
      resolve(undefined)
    }
    function check () { if (pc.iceGatheringState === 'complete') done() }
    pc.addEventListener('icegatheringstatechange', check)
  })
}

/** Resolves with the data channel once it is open, or rejects when it does not open in time or the connection fails. @param {RTCPeerConnection} pc @param {Promise<RTCDataChannel>} channelPromise */
function opened (pc, channelPromise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { fail(new Error('The peer did not connect in time.')) }, OPEN_MS)
    function fail (/** @type {Error} */ error) { clearTimeout(timer); try { pc.close() } catch { /* closed */ } reject(error) }
    pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') fail(new Error('The peer could not be reached.')) })
    channelPromise.then((channel) => {
      if (channel.readyState === 'open') { clearTimeout(timer); resolve(channel); return }
      channel.addEventListener('open', () => { clearTimeout(timer); resolve(channel) }, { once: true })
    }, fail)
  })
}

/**
 * The leecher's side of an introduction: a connection with a channel in it, and the offer to send through a tracker.
 * `connect(answer)` finishes it and resolves with the open channel.
 * @param {RtcOptions} [options]
 * @returns {Promise<{ offer: { type: 'offer', sdp: string }, connect: (answer: { type: 'answer', sdp: string }) => Promise<RTCDataChannel>, close: () => void }>}
 */
export async function makeOffer ({ RTCPeerConnectionImpl = globalThis.RTCPeerConnection, iceServers = ICE_SERVERS, gatherMs = GATHER_MS } = {}) {
  const pc = new RTCPeerConnectionImpl({ iceServers })
  const channel = pc.createDataChannel(CHANNEL_LABEL, { ordered: true })
  await pc.setLocalDescription(await pc.createOffer())
  await gathered(pc, gatherMs)
  const sdp = pc.localDescription?.sdp
  if (typeof sdp !== 'string') { pc.close(); throw new Error('The connection could not make an offer.') }
  return {
    offer: { type: 'offer', sdp },
    async connect (answer) {
      const ready = opened(pc, Promise.resolve(channel))
      await pc.setRemoteDescription(answer)
      return await ready
    },
    close () { try { pc.close() } catch { /* closed */ } }
  }
}

/**
 * The seeder's side: takes an offer, makes the answer to send back, and resolves `channel` once the peer's channel
 * is open.
 * @param {{ type: 'offer', sdp: string }} offer
 * @param {RtcOptions} [options]
 * @returns {Promise<{ answer: { type: 'answer', sdp: string }, channel: Promise<RTCDataChannel>, close: () => void }>}
 */
export async function acceptOffer (offer, { RTCPeerConnectionImpl = globalThis.RTCPeerConnection, iceServers = ICE_SERVERS, gatherMs = GATHER_MS } = {}) {
  const pc = new RTCPeerConnectionImpl({ iceServers })
  const incoming = new Promise((/** @type {(channel: RTCDataChannel) => void} */ resolve) => {
    pc.addEventListener('datachannel', (event) => { if (event.channel.label === CHANNEL_LABEL) resolve(event.channel) })
  })
  await pc.setRemoteDescription(offer)
  await pc.setLocalDescription(await pc.createAnswer())
  await gathered(pc, gatherMs)
  const sdp = pc.localDescription?.sdp
  if (typeof sdp !== 'string') { pc.close(); throw new Error('The connection could not make an answer.') }
  const channel = opened(pc, incoming)
  channel.catch(() => {})
  return { answer: { type: 'answer', sdp }, channel: /** @type {Promise<RTCDataChannel>} */ (channel), close () { try { pc.close() } catch { /* closed */ } } }
}

// How the dashboard says how the node is reached, in a person's words: one sentence for each reason the node gives with its
// `reach` (the table "What the node says about being reached" in the node's README), the state of the node's process, and why a
// relay helps. A reason a newer node adds is shown as the node says it, never as a blank.

/** The reasons the node gives, each with the sentence a person reads. The test keeps this list equal to the Worker's `REASONS`. */
export const REASON_WORDS = Object.freeze({
  autonat: 'The node confirmed an address that computers on the internet can connect to directly.',
  punched: 'A computer on the internet connected straight to the node through your router.',
  'named-relay': 'The relay you named holds a place for the node and passes its traffic with no limit, so a visitor gets in through it.',
  'open-relay': 'A relay the node found by itself holds a place for it and passes its traffic with no limit, so a visitor gets in through it.',
  'punch-ready': 'The relays agree on the address a visitor would use and a direct connection can work, but none has been tried yet.',
  'punch-failed': 'The relays agree on the address, but every direct connection tried so far failed. A visitor may be the one behind a strict router.',
  looking: 'The node is still checking: it waits for a relay, a second sighting of its address, or the limit of a relay.',
  'not-measured': 'Nothing has been measured yet. This is normal for the first minute after the node starts.',
  'relay-limited': 'The relays that hold a place for the node all limit what they pass, and the node cannot connect directly. Naming a relay without a limit fixes it.',
  'symmetric-nat': 'Your router gives every destination its own port, so the node cannot offer one address to a visitor, and no relay without a limit holds a place for it. Naming a relay fixes it.',
  'no-public-relay': 'No relay holds a place for the node and none is left to ask. Naming a relay fixes it.',
  'not-reachable': 'A computer on the internet tried to connect to the node and failed, and nothing else gives a way in. Naming a relay fixes it.'
})

/** What each state of the node's process says. */
export const NODE_WORDS = Object.freeze({
  starting: 'Starting',
  up: 'Running',
  restarting: 'Restarting',
  failed: 'Did not start'
})

/** @param {string | null | undefined} reason @returns {string} the sentence for a reason, or the node's own word for one this page has not heard of */
export function reasonWords (reason) {
  if (reason === null || reason === undefined || reason === '') return 'The node gave no reason.'
  return Object.hasOwn(REASON_WORDS, reason) ? REASON_WORDS[/** @type {keyof typeof REASON_WORDS} */ (reason)] : `The node says: ${reason}.`
}

/** @param {string} state a state of the node's process @returns {string} */
export const nodeWords = (state) => (Object.hasOwn(NODE_WORDS, state) ? NODE_WORDS[/** @type {keyof typeof NODE_WORDS} */ (state)] : state)

/** Why a relay helps, and who names it: shown beside the relay field. */
export const RELAY_WHY = 'Behind a home router, nobody on the internet can start a connection to your node. A relay is a public computer that accepts the connection for it, so a visitor can get in. Orivon names no relay: use one you run or trust.'

/** What saving or removing a relay does, said before the person presses the button. */
export const RELAY_RESTART = 'The node starts again when you save or remove a relay. What it keeps is not touched.'

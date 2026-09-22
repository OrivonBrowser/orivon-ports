// The half of every bridge that is the same in every port: one named error,
// refusal by name, the listener recorder, and the installer that merges each
// global's groups onto window.
//
// Not a module. This file is spliced verbatim into the composed bridge
// (../compose.ts), inside its IIFE and after the `GLOBALS` the composer
// emits, so it runs as a classic script with everything in one scope.

const REFUSAL_REASONS = {
  excluded: 'excluded from Orivon by decision',
  'shell-owned': 'the browser owns this, not the app',
  'not-built': 'not built in this port'
}

/** The global a member that names no owner belongs to. Unambiguous only when the app exposed one. */
const ONLY_GLOBAL = GLOBALS.length === 1 ? GLOBALS[0] : undefined

class BridgeError extends Error {
  constructor (member, reason, detail, owner) {
    const on = owner ?? ONLY_GLOBAL ?? 'bridge'
    super(`${on}.${member} is unavailable: ${REFUSAL_REASONS[reason]}${detail === undefined ? '' : ` (${detail})`}`)
    this.name = 'OrivonBridgeError'
    this.member = member
    this.reason = reason
    this.owner = on
  }
}

/**
 * A member Orivon cannot honour throws with a reason. It is never absent:
 * `undefined is not a function`, inside somebody else's bundle, explains
 * nothing to the person reading the console.
 */
function refuse (member, reason, detail, owner) {
  return () => { throw new BridgeError(member, reason, detail, owner) }
}

/** Read at every call, never captured: a grant that arrives later then works, and a test can swap the fake between calls. */
function getOrivon () {
  return window.orivon
}

const recordedByGlobal = {}

function recorder (owner, name) {
  return (callback) => {
    const recorded = recordedByGlobal[owner] ?? (recordedByGlobal[owner] = {})
    recorded[name] = callback
  }
}

const exposed = {}

const kit = {
  BridgeError,
  refuse,
  getOrivon,
  /** For a member's own unit tests: a classic script has no exports, so anything a test needs is published on __orivonBridgeInternals.app. */
  expose: (name, value) => { exposed[name] = value }
}

/**
 * What the app's own file returned, split per global. One global takes a flat
 * member map; several take one map per global name, because two globals may
 * each have a `get` and a flat map would silently keep one of them.
 */
function splitHand (supplied, names) {
  if (supplied === undefined) return {}
  if (names.length === 1) return { [names[0]]: supplied }
  const split = {}
  for (const key of Object.keys(supplied)) {
    if (!names.includes(key)) {
      throw new Error(`orivon bridge: appMembers returned "${key}", which is not one of the globals this bridge declares (${names.join(', ')})`)
    }
    split[key] = supplied[key]
  }
  return split
}

function mergeGroups (owner, groups) {
  const bridge = {}
  const source = {}
  for (const [bucket, members] of groups) {
    for (const name of Object.keys(members)) {
      if (Object.prototype.hasOwnProperty.call(bridge, name)) {
        throw new Error(`orivon bridge: ${owner}.${name} is installed twice, by ${source[name]} and by ${bucket}`)
      }
      bridge[name] = members[name]
      source[name] = bucket
    }
  }
  return { bridge, source }
}

function checkHand (owner, source, hand) {
  const supplied = Object.keys(source).filter((name) => source[name] === 'hand')
  const missing = hand.filter((name) => !supplied.includes(name))
  const extra = supplied.filter((name) => !hand.includes(name))
  if (missing.length === 0 && extra.length === 0) return
  const parts = []
  if (missing.length > 0) parts.push(`declared in members.json but not returned by appMembers: ${missing.join(', ')}`)
  if (extra.length > 0) parts.push(`returned by appMembers but not declared in members.json's "hand": ${extra.join(', ')}`)
  throw new Error(`orivon bridge: ${owner}: ${parts.join('; ')}`)
}

/**
 * Installs every declared global. Two groups answering one member is a bridge
 * whose behaviour depends on which one merged last, so it throws here instead
 * -- at the first script in <head>, before the app's own bundle has run a
 * line.
 */
function installBridges (declared, supplied) {
  const names = declared.map(([name]) => name)
  const hands = splitHand(supplied, names)
  const installed = {}

  for (const [owner, groups, hand] of declared) {
    const withHand = [...groups, ['hand', hands[owner] ?? {}]]
    const { bridge, source } = mergeGroups(owner, withHand)
    checkHand(owner, source, hand)
    window[owner] = bridge
    installed[owner] = { bridge, recordedListeners: recordedByGlobal[owner] ?? (recordedByGlobal[owner] = {}) }
  }

  const internals = { globals: installed, app: exposed, BridgeError, refuse }
  if (names.length === 1) {
    internals.global = names[0]
    internals.bridge = installed[names[0]].bridge
    internals.recordedListeners = installed[names[0]].recordedListeners
  }
  globalThis.__orivonBridgeInternals = internals
  return installed
}

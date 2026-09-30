// The error a refused module throws: named, coded and saying why, so a
// caller who reaches a dependency this port left out reads the reason in
// the server's log rather than "x is not a function".

/** @returns {Error & { code: string }} */
export function refusal (what, why) {
  return Object.assign(new Error(`${what} is refused by the Orivon port of The Lounge: ${why}`), { name: 'OrivonPortRefusal', code: 'ORIVON_PORT_REFUSED' })
}

/** A function that throws the refusal when called. */
export function refusing (what, why) {
  return function refused () { throw refusal(what, why) }
}

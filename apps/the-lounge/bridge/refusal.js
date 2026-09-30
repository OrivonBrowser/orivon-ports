// The error a refused module throws: named, coded and saying why, so a
// caller who reaches a dependency this port left out reads the reason in
// the server's log rather than "x is not a function".

export function refusal (what, why) {
  const error = new Error(`${what} is refused by the Orivon port of The Lounge: ${why}`)
  error.name = 'OrivonPortRefusal'
  error.code = 'ORIVON_PORT_REFUSED'
  return error
}

/** A function that throws the refusal when called. */
export function refusing (what, why) {
  return function refused () { throw refusal(what, why) }
}

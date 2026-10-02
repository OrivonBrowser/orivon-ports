// What the probes together need from the manifest, and how to compare it with what the
// manifest says. Pure. The manifest test uses these to keep orivon.json equal to the
// union of every probe's `declares`, so a probe cannot ship without its capability.

/** @param {unknown} value */
function isObject (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep-merge `source` into `target`: objects merge key by key, arrays take the union in
 * first-seen order, anything else is replaced.
 * @param {Record<string, any>} target
 * @param {Record<string, any>} source
 */
function mergeInto (target, source) {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key]
    if (isObject(value) && isObject(existing)) mergeInto(existing, value)
    else if (isObject(value)) target[key] = mergeInto({}, value)
    else if (Array.isArray(value) && Array.isArray(existing)) target[key] = [...new Set([...existing, ...value])]
    else target[key] = Array.isArray(value) ? [...value] : value
  }
  return target
}

/**
 * The manifest `capabilities` object the probes need together.
 * @param {readonly { declares: Record<string, any> }[]} probes
 * @returns {Record<string, any>}
 */
export function mergeDeclarations (probes) {
  return probes.reduce((merged, probe) => mergeInto(merged, probe.declares), {})
}

/**
 * Whether `actual` holds everything in `wanted`: every key, and every array element.
 * @param {unknown} actual
 * @param {unknown} wanted
 * @returns {boolean}
 */
export function contains (actual, wanted) {
  if (isObject(wanted)) {
    if (!isObject(actual)) return false
    const have = /** @type {Record<string, unknown>} */ (actual)
    return Object.entries(wanted).every(([key, value]) => key in have && contains(have[key], value))
  }
  if (Array.isArray(wanted)) {
    return Array.isArray(actual) && wanted.every((item) => actual.some((candidate) => contains(candidate, item)))
  }
  return actual === wanted
}

/**
 * The differences between two capabilities objects, one line each; empty when equal.
 * @param {unknown} expected
 * @param {unknown} actual
 * @returns {string[]}
 */
export function diffCapabilities (expected, actual) {
  return [
    ...(contains(actual, expected) ? [] : ['the manifest lacks something the probes declare']),
    ...(contains(expected, actual) ? [] : ['the manifest declares something no probe declares'])
  ]
}

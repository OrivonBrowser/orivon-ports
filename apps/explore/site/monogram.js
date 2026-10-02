// A card's tile: initials on a colour taken from the site's id. A real logo is an image
// and somebody's trademark, so none is shipped.

/** One or two characters: the first letters of the first two words, or the first two letters of one. */
export function initials (name) {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const [first = '', second = ''] = words
  if (second) return (first.charAt(0) + second.charAt(0)).toUpperCase()
  return first.slice(0, 2).charAt(0).toUpperCase() + first.slice(1, 2).toLowerCase()
}

/** A stable hue in 0..359, the same for the same id on every load. */
export function hue (id) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 3600
  return Math.floor(hash / 10)
}

// The presets the challenge picker offers ahead of the installed challenges: each is one challenge of ours, added with its defaults, under the words a
// board owner knows it by. A preset is offered only when the node lists the challenge, so an older node's picker is as it was.

/** @typedef {{ name: string, title: string, short: string }} Preset `title` is the picker's line, `short` the name a row and the list of changes use */

/** @type {readonly Readonly<Preset>[]} */
export const PRESETS = Object.freeze([
  { name: '@orivon/id-challenge', title: 'Require an Orivon ID', short: 'Orivon ID' }
])

/** @param {string} name @returns {Preset | undefined} */
export const presetOf = (name) => PRESETS.find((one) => one.name === name)

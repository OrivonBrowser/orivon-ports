// The word an app uses for what a node hosts: 5chan says "board", seedit says "community". The app names it in `app.term`; every
// section builds its sentences from these four forms, so a page never says the other app's word.

/** @typedef {{ board: string, boards: string, Board: string, Boards: string }} Term */

/** @type {Term} */
export const BOARD = { board: 'board', boards: 'boards', Board: 'Board', Boards: 'Boards' }
/** @type {Term} */
export const COMMUNITY = { board: 'community', boards: 'communities', Board: 'Community', Boards: 'Communities' }

/** @param {{ term?: string }} app @returns {Term} */
export const termOf = (app) => (app.term === 'community' ? COMMUNITY : BOARD)

// The tab's title follows what the page shows: "<what is open> · Orivon Share".

export const BASE_TITLE = 'Orivon Share'

/** @param {string} [name] what is open; nothing shows the bare name */
export function setTitle (name) {
  document.title = name ? `${name} · ${BASE_TITLE}` : BASE_TITLE
}

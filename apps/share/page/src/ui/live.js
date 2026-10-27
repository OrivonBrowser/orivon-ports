// The two live regions of index.html: polite status for progress, assertive alerts for errors.

/** @param {string} text */
export function announce (text) {
  const region = document.getElementById('status')
  if (region) region.textContent = text
}

/** @param {string} text */
export function alertText (text) {
  const region = document.getElementById('alerts')
  if (!region) return
  region.textContent = ''
  setTimeout(() => { region.textContent = text }, 30)
}

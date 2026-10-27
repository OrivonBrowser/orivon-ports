// The theme the person picked in Settings: "system" follows the browser, the others override it.

/** @typedef {'system' | 'light' | 'dark'} Theme */

/** @param {unknown} value @returns {Theme} */
export function themeOf (value) {
  return value === 'light' || value === 'dark' ? value : 'system'
}

/** @param {Theme} theme */
export function applyTheme (theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}

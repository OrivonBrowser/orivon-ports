// What a share is, from the shape of what is published (nothing was added to a public share to say):
// a directory of `share.age` and `HOW-TO-OPEN.txt` only is encrypted; one with `index.html` at its root is a
// website; one holding a single folder is a folder; anything else is files.

export const ENCRYPTED_NAMES = ['HOW-TO-OPEN.txt', 'share.age']

/** @param {string[]} rootNames the names in the root directory */
export function isEncrypted (rootNames) {
  const sorted = [...rootNames].sort()
  return sorted.length === ENCRYPTED_NAMES.length && sorted.every((name, index) => name === ENCRYPTED_NAMES[index])
}

/**
 * @param {string[]} rootNames the names in the root directory
 * @param {string[]} filePaths every file below it
 * @returns {'files' | 'folder' | 'website'}
 */
export function kindOf (rootNames, filePaths) {
  if (filePaths.includes('index.html')) return 'website'
  const only = rootNames.length === 1 ? rootNames[0] : undefined
  if (only !== undefined && filePaths.length > 0 && filePaths.every((path) => path.startsWith(`${only}/`))) return 'folder'
  return 'files'
}

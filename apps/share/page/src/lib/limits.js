// The limits that bound a share, in one place. Free pinning's own limits (FREE_MAX_BYTES, FREE_DAYS) are in
// publish/targets.js.

/** The most one share holds, for every place it can be kept but free pinning. */
export const MAX_SHARE_BYTES = 1024 * 1024 * 1024
export const MAX_FILES = 10000
export const MIN_PASSWORD_LENGTH = 10
export const MAX_TITLE_CHARACTERS = 120
export const MAX_MESSAGE_CHARACTERS = 2000

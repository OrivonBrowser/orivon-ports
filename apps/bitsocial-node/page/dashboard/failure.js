// How a section words what a node call threw, and which refusals mean the node has no such feature at all.

/** What the node answers when it has no such call: a build without it, or a node from before there was one. */
export const NOT_OFFERED = [403, 404, 503]

/**
 * @param {unknown} error what a call threw: a refusal carries `status` and the node's own message
 * @returns {{ words: string, status: number | null }}
 */
export function failure (error) {
  const message = error instanceof Error ? error.message : String(error)
  const status = /** @type {any} */ (error)?.status
  return { words: typeof status === 'number' ? message : `The node did not answer: ${message}`, status: typeof status === 'number' ? status : null }
}

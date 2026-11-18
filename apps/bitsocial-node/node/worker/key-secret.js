// The secret the node seals its IPNS keys under (`--key-secret`), kept in a file beside the node's database. It is made
// once, on the first start, and every later start reads the same one: a node started with another secret finds
// `keys.db` locked and refuses every key route. A file that exists and holds something else is an error, never a reason
// to make a new secret, which would lock the keys it protects.

const SECRET_SHAPE = /^[0-9a-f]{64}$/

/**
 * @param {{ path: string, read: (path: string) => Promise<string | null>, write: (path: string, text: string) => Promise<unknown>, randomHex: (bytes: number) => string }} options
 *   `read` answers null for a file that does not exist
 * @returns {Promise<string>} 64 hexadecimal characters
 */
export async function keySecret ({ path, read, write, randomHex }) {
  const kept = await read(path)
  if (kept !== null) {
    const secret = kept.trim()
    if (!SECRET_SHAPE.test(secret)) throw new Error(`${path} is not a key secret (64 hexadecimal characters): the node's keys are sealed under it, so it is not replaced`)
    return secret
  }
  const made = randomHex(32)
  await write(path, `${made}\n`)
  return made
}

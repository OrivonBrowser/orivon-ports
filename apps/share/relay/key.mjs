import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'

export const KEY_FILE = 'peer-key.pb'

/**
 * The relay's Ed25519 identity, read from `stateDir` or made there on the first start. A key file that
 * exists but cannot be read stops the start: a new key would change the relay's peer ID, and every
 * share that announced the old one would stop answering.
 */
export async function loadOrCreateKey (stateDir) {
  const file = join(stateDir, KEY_FILE)
  let bytes
  try {
    bytes = await readFile(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (bytes != null) return privateKeyFromProtobuf(bytes)

  const key = await generateKeyPair('Ed25519')
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const temporary = `${file}.new`
  await writeFile(temporary, privateKeyToProtobuf(key), { mode: 0o600 })
  await rename(temporary, file)
  return key
}

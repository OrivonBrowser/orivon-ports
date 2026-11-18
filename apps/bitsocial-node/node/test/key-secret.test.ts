// The secret the node's keys are sealed under: made once, read back every time, never replaced by a guess.
import { describe, expect, it } from 'vitest'
import { keySecret } from '../worker/key-secret.js'

const files = (initial: Record<string, string> = {}) => {
  const held = new Map(Object.entries(initial))
  return { held, read: async (path: string) => held.get(path) ?? null, write: async (path: string, text: string) => { held.set(path, text) } }
}

describe('keySecret', () => {
  it('makes a secret the first time and keeps it in the file', async () => {
    const disk = files()
    const secret = await keySecret({ path: '/files/node/keys.secret', read: disk.read, write: disk.write, randomHex: () => 'c'.repeat(64) })
    expect(secret).toBe('c'.repeat(64))
    expect(disk.held.get('/files/node/keys.secret')).toBe(`${'c'.repeat(64)}\n`)
  })

  it('returns the secret the file holds, and makes none', async () => {
    const disk = files({ '/files/node/keys.secret': `${'d'.repeat(64)}\n` })
    const secret = await keySecret({ path: '/files/node/keys.secret', read: disk.read, write: disk.write, randomHex: () => { throw new Error('made one') } })
    expect(secret).toBe('d'.repeat(64))
  })

  it('refuses a file that holds something else, which a new secret would lock the keys out of', async () => {
    const disk = files({ '/files/node/keys.secret': 'garbage' })
    await expect(keySecret({ path: '/files/node/keys.secret', read: disk.read, write: disk.write, randomHex: () => 'e'.repeat(64) })).rejects.toThrow(/not replaced/)
    expect(disk.held.get('/files/node/keys.secret')).toBe('garbage')
  })
})

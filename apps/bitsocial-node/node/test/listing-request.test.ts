// The request a board owner sends to be listed: the entry and the message the board's key signs, the signature, and its check
// against nothing but the board's address. The signature is also checked here with Node's own crypto, so what the Worker's
// signing library says is not the only witness.
import { createPublicKey, verify } from 'node:crypto'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { describe, expect, it } from 'vitest'
import { entryOf, holdsKey, messageOf, OWNER_NAME, peerKeyOf, REQUEST_FILE, REQUEST_PREFIX, signRequest, verifyRequest } from '../worker/listing-request.js'

/** A board's key as pkc-js keeps it: the 32-byte seed in base 64, and the address that is its peer ID. */
async function boardKey () {
  const key = await generateKeyPair('Ed25519')
  return { privateKey: Buffer.from(key.raw.subarray(0, 32)).toString('base64'), address: peerIdFromPrivateKey(key).toString() }
}

const FILE = '5chan-directories/5chan-a-directory.json'
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')

/** Node's own check of an Ed25519 signature over a message, given the board's address. */
function nodeVerifies (message: string, signature: string, address: string): boolean {
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, peerKeyOf(address)]), format: 'der', type: 'spki' })
  return verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64'))
}

describe('the entry of a 5chan directory', () => {
  it('has the address, the public key, when it was added and, when the owner names themselves, the owner', () => {
    expect(entryOf({ file: FILE, address: 'music.bso', publicKey: '12D3KooWKey', addedAt: 1_779_182_014, owner: 'me.bso' })).toEqual({ address: 'music.bso', publicKey: '12D3KooWKey', addedAt: 1_779_182_014, owner: 'me.bso' })
    const bare = entryOf({ file: FILE, address: '12D3KooWKey', publicKey: '12D3KooWKey', addedAt: 7 })
    expect(Object.keys(bare)).toEqual(['address', 'publicKey', 'addedAt'])
  })

  it('is written in the order the lists write it', () => {
    expect(JSON.stringify(entryOf({ file: FILE, address: 'a.bso', publicKey: 'K', addedAt: 1, owner: 'o.bso' }))).toBe('{"address":"a.bso","publicKey":"K","addedAt":1,"owner":"o.bso"}')
  })
})

describe('the entry of a seedit directory', () => {
  it('has the address, when it was added and the public key, and takes no owner', () => {
    const entry = entryOf({ file: 'seedit-directories/seedit-cats-directory.json', address: 'cats.bso', publicKey: '12D3KooWKey', addedAt: 5, owner: 'me.bso' })
    expect(JSON.stringify(entry)).toBe('{"address":"cats.bso","addedAt":5,"publicKey":"12D3KooWKey"}')
  })
})

describe('the file a request names', () => {
  it('is a directory file of the lists, and nothing else', () => {
    for (const ok of [FILE, '5chan-directories/5chan-3-directory.json', 'seedit-directories/seedit-todayilearned-directory.json']) expect(REQUEST_FILE.test(ok)).toBe(true)
    for (const bad of ['5chan-directories/seedit-a-directory.json', '../5chan-directories/5chan-a-directory.json', '5chan-directories/5chan-a-directory.json\nentry: {}', '5chan-directories/5chan--directory.json', 'README.md', '5chan-directories/5chan-a/b-directory.json']) expect(REQUEST_FILE.test(bad)).toBe(false)
  })

  it('and the owner is a name that ends .bso or .eth', () => {
    for (const ok of ['me.bso', 'a-b.c.eth']) expect(OWNER_NAME.test(ok)).toBe(true)
    for (const bad of ['me', 'me.com', '.bso', 'a b.bso', 'a\n.bso', 'ME.bso']) expect(OWNER_NAME.test(bad)).toBe(false)
  })
})

describe('the message the board signs', () => {
  it('names the lists, the directory file and the entry, one to a line, behind a fixed first line', () => {
    const entry = entryOf({ file: FILE, address: 'a.bso', publicKey: 'K', addedAt: 1 })
    expect(messageOf({ file: FILE, entry })).toBe(`${REQUEST_PREFIX}\nlist: bitsocialnet/lists\nfile: ${FILE}\nentry: {"address":"a.bso","publicKey":"K","addedAt":1}`)
    expect(REQUEST_PREFIX).toBe('bitsocial-listing-request-v1')
  })
})

describe('the signature', () => {
  it('verifies with the board\'s public key, taken from its address alone', async () => {
    const key = await boardKey()
    const entry = entryOf({ file: FILE, address: key.address, publicKey: key.address, addedAt: 1_800_000_000 })
    const message = messageOf({ file: FILE, entry })
    const signature = await signRequest({ message, privateKey: key.privateKey, publicKey: key.address })
    expect(signature).toMatch(/^[A-Za-z0-9+/]{86}==$/)
    expect(await verifyRequest({ message, signature, publicKey: key.address })).toBe(true)
    expect(nodeVerifies(message, signature, key.address)).toBe(true)
  })

  it('fails for another message, another entry, another key and a damaged signature', async () => {
    const key = await boardKey()
    const other = await boardKey()
    const message = messageOf({ file: FILE, entry: entryOf({ file: FILE, address: key.address, publicKey: key.address, addedAt: 1 }) })
    const signature = await signRequest({ message, privateKey: key.privateKey, publicKey: key.address })
    expect(await verifyRequest({ message: message.replace('a-directory', 'b-directory'), signature, publicKey: key.address })).toBe(false)
    expect(await verifyRequest({ message: message.replace('"addedAt":1', '"addedAt":2'), signature, publicKey: key.address })).toBe(false)
    expect(await verifyRequest({ message, signature, publicKey: other.address })).toBe(false)
    expect(await verifyRequest({ message, signature: `${signature.slice(0, 10)}AAAA${signature.slice(14)}`, publicKey: key.address })).toBe(false)
    expect(nodeVerifies(message.replace('a-directory', 'b-directory'), signature, key.address)).toBe(false)
    expect(nodeVerifies(message, signature, other.address)).toBe(false)
  })

  it('is the same for the same message, as an Ed25519 signature is', async () => {
    const key = await boardKey()
    const message = `${REQUEST_PREFIX}\nsame`
    expect(await signRequest({ message, privateKey: key.privateKey, publicKey: key.address })).toBe(await signRequest({ message, privateKey: key.privateKey, publicKey: key.address }))
  })

  it('is refused for a key that is not the one the public key names, which a delegated board\'s node holds', async () => {
    const mine = await boardKey()
    const owners = await boardKey()
    expect(await holdsKey({ privateKey: mine.privateKey, publicKey: mine.address })).toBe(true)
    expect(await holdsKey({ privateKey: mine.privateKey, publicKey: owners.address })).toBe(false)
    await expect(signRequest({ message: 'x', privateKey: mine.privateKey, publicKey: owners.address })).rejects.toThrow(/does not hold/)
  })

  it('refuses an address that is not an Ed25519 peer ID, and a signature that is not base 64 of 64 bytes', async () => {
    expect(() => peerKeyOf('music.bso')).toThrow(/not an Ed25519 peer ID/)
    expect(() => peerKeyOf('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toThrow(/not an Ed25519 peer ID/)
    const key = await boardKey()
    expect(await verifyRequest({ message: 'x', signature: 'not a signature', publicKey: key.address })).toBe(false)
    expect(await verifyRequest({ message: 'x', signature: 'AAAA', publicKey: key.address })).toBe(false)
  })
})

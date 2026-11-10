// The resolver bound at signing (M2) and the fourth clause of the attribution rule (M3), on a chain made of tables: the
// holder can write the name's records on its resolver, so the holder can end its sign-ins and the resolver is not
// someone else's. The fork test (fork-revocation.test.ts) runs the same cases against the deployed contracts.

import { describe, expect, it } from 'vitest'
import { toChecksumAddress } from '../site/sdk/abi.js'
import { toHex, utf8 } from '../site/sdk/bytes.js'
import { revokeAllCall } from '../site/sdk/connect.js'
import { attribution, ADDRESSES } from '../site/sdk/orivonid.js'
import {
  addressResource, ETH_COIN_TYPE, NOT_BEFORE_KEY, RECORD_ROLES, recordsHeld, ROLE_SET_ADDRESS, ROLE_SET_TEXT, textResource
} from '../site/sdk/permissions.js'
import { verifyAction, verifySignIn } from '../site/sdk/verify.js'
import { recordsNotHeldWords, signIn, whyNotOffered, parseRequest } from '../site/connect-request.js'
import { keccak256 } from '../site/sdk/keccak.js'
import { ChainError } from '../site/sdk/chain.js'
import * as registerTx from '../site/register-tx.js'
import { runFlow } from './support/signin-flow.ts'
import { aliceWorld, NOW, ORIGIN, RESOLVER, signInChain, SIGNER } from './support/signin-world.ts'

const NEW_RESOLVER = toChecksumAddress('0x' + '5c'.repeat(20))
const GIVER = toChecksumAddress('0x' + 'a1'.repeat(20))
const verify = async (env: ReturnType<typeof signInChain>, flow: Awaited<ReturnType<typeof runFlow>>) =>
  await verifySignIn(flow.response, { chain: env.chain, origin: ORIGIN, nonce: flow.nonce, key: flow.key.hex, ttl: 2_592_000, now: NOW + 5 })

describe('what a PermissionedResolver checks, as constants', () => {
  it('has the role bits and resources the contract computes (PermissionedResolverLib)', () => {
    expect(ROLE_SET_ADDRESS).toBe(1n)
    expect(ROLE_SET_TEXT).toBe(16n)
    expect(RECORD_ROLES).toBe(17n)
    expect(ETH_COIN_TYPE).toBe(60n)
    expect(textResource('a')).toBe(BigInt('0x' + toHex(keccak256(utf8('a')))))
    expect(addressResource(60n)).toBe(BigInt('0x' + toHex(keccak256(Uint8Array.of(...new Array(31).fill(0), 60)))))
    expect(NOT_BEFORE_KEY).toBe('eth.orivonstack.id.not-before')
  })

  it('are the same as the ones registration uses', () => {
    expect([registerTx.ROLE_SET_ADDRESS, registerTx.ROLE_SET_TEXT, registerTx.RECORD_ROLES, registerTx.ETH_COIN_TYPE]).toEqual([ROLE_SET_ADDRESS, ROLE_SET_TEXT, RECORD_ROLES, ETH_COIN_TYPE])
  })
})

describe('recordsHeld', () => {
  const parts = { resolver: RESOLVER, holder: SIGNER, factory: ADDRESSES.verifiableFactory, implementation: ADDRESSES.resolverImplementation }
  const reading = (answers: { verify?: unknown, text?: unknown, address?: unknown }) => async (to: string, signature: string, args: unknown[]) => {
    const answer = signature === 'verifyContract(address)' ? answers.verify : (args[0] === textResource(NOT_BEFORE_KEY) ? answers.text : answers.address)
    if (answer instanceof Error) throw answer
    return [answer]
  }
  const revert = new ChainError('reverted', 'no')

  it('holds when the factory names the implementation and the holder has both roles', async () => {
    expect(await recordsHeld(reading({ verify: ADDRESSES.resolverImplementation, text: true, address: true }), parts)).toEqual({ ok: true, problem: null })
  })

  it('names what is missing', async () => {
    const ok = ADDRESSES.resolverImplementation
    expect(await recordsHeld(reading({ verify: revert }), parts)).toEqual({ ok: false, problem: 'notPermissionedResolver' })
    expect(await recordsHeld(reading({ verify: new ChainError('badAnswer', 'x') }), parts)).toEqual({ ok: false, problem: 'notPermissionedResolver' })
    expect(await recordsHeld(reading({ verify: GIVER }), parts)).toEqual({ ok: false, problem: 'notPermissionedResolver' })
    expect(await recordsHeld(reading({ verify: ok, text: false, address: true }), parts)).toEqual({ ok: false, problem: 'textRoleMissing' })
    expect(await recordsHeld(reading({ verify: ok, text: true, address: false }), parts)).toEqual({ ok: false, problem: 'addressRoleMissing' })
    expect(await recordsHeld(reading({ verify: ok, text: revert, address: true }), parts)).toEqual({ ok: false, problem: 'unreadable' })
    expect(await recordsHeld(reading({ verify: ok, text: true, address: new ChainError('badAnswer', 'x') }), parts)).toEqual({ ok: false, problem: 'unreadable' })
  })

  it('does not turn a node that cannot be asked into an answer', async () => {
    await expect(recordsHeld(reading({ verify: new ChainError('unavailable', 'down') }), parts)).rejects.toMatchObject({ reason: 'unavailable' })
    await expect(recordsHeld(reading({ verify: ADDRESSES.resolverImplementation, text: new ChainError('timeout', 'slow'), address: true }), parts)).rejects.toMatchObject({ reason: 'timeout' })
  })
})

describe('M2: a sign-in is bound to the resolver its username was signed with', () => {
  it('signs the resolver into the username\'s resource', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain, withKey: true })
    expect(flow.response.message).toContain(`- orivonid:name:alice.v1.orivonid.eth#${RESOLVER.toLowerCase()}\n`)
  })

  it('refuses a sign-in once the name points at another resolver, even one that gives the same address and holds no revocation', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain, withKey: true })
    expect(await verify(env, flow)).toMatchObject({ ok: true })
    env.world.resolvers[RESOLVER]!.texts = { [NOT_BEFORE_KEY]: String(NOW + 400) }
    expect(await verify(env, flow)).toMatchObject({ ok: false, failure: 'revoked' })
    env.world.resolvers[NEW_RESOLVER] = { addr: SIGNER }
    env.world.names['alice']!.resolver = NEW_RESOLVER
    expect(await verify(env, flow)).toEqual({ ok: false, failure: 'resolverChanged', detail: NEW_RESOLVER, name: 'alice.v1.orivonid.eth' })
    const payload = utf8('act')
    expect(await verifyAction({ signIn: flow.response, payload, signature: await flow.key.sign(payload), origin: ORIGIN, chain: env.chain, now: NOW + 5 }))
      .toMatchObject({ ok: false, failure: 'resolverChanged' })
  })

  it('keeps a revocation in force when the name returns to the resolver it was signed with', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain, withKey: true })
    env.world.resolvers[RESOLVER]!.texts = { [NOT_BEFORE_KEY]: String(NOW + 400) }
    env.world.resolvers[NEW_RESOLVER] = { addr: SIGNER }
    env.world.names['alice']!.resolver = NEW_RESOLVER
    expect(await verify(env, flow)).toMatchObject({ failure: 'resolverChanged' })
    env.world.names['alice']!.resolver = RESOLVER
    expect(await verify(env, flow)).toMatchObject({ ok: false, failure: 'revoked' })
  })

  it('says resolverChanged for a name whose resolver was taken away', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain })
    env.world.names['alice']!.resolver = undefined
    expect(await verifySignIn(flow.response, { chain: env.chain, origin: ORIGIN, nonce: flow.nonce, key: null, now: NOW + 5 })).toMatchObject({ failure: 'resolverChanged', detail: 'none' })
  })

  it('refuses a message that binds a name to a resolver it was not signed with', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain })
    const forged = { ...flow.response, message: flow.response.message.replace(RESOLVER.toLowerCase(), RESOLVER.toLowerCase().replace(/7e/g, '7f')) }
    expect(await verifySignIn(forged, { chain: env.chain, origin: ORIGIN, nonce: flow.nonce, key: null, now: NOW + 5 })).toMatchObject({ ok: false, failure: 'badSignature' })
  })
})

describe('M3: the holder can write the name\'s records on its resolver', () => {
  const gifted = () => {
    const env = signInChain(aliceWorld())
    env.world.resolvers[RESOLVER]!.roles = { [GIVER.toLowerCase()]: 17n }
    return env
  }

  it('is a fourth clause of the attribution rule, with the others holding', async () => {
    const found = await attribution(gifted().chain, 'alice', SIGNER)
    expect(found).toMatchObject({ ok: false, owner: { ok: true }, roles: { ok: true }, forward: { ok: true }, records: { ok: false, resolver: RESOLVER, problem: 'textRoleMissing' } })
    const own = signInChain()
    expect(await attribution(own.chain, 'alice', SIGNER)).toMatchObject({ ok: true, records: { ok: true, resolver: RESOLVER, problem: null } })
  })

  it('reads the root roles and the roles on the one resource, as the contract does', async () => {
    const env = signInChain()
    const state = env.world.resolvers[RESOLVER]!
    const me = SIGNER.toLowerCase()
    state.roles = { [me]: ROLE_SET_TEXT | ROLE_SET_ADDRESS }
    expect((await attribution(env.chain, 'alice', SIGNER)).records.ok).toBe(true)
    state.roles = { [me]: ROLE_SET_TEXT }
    expect((await attribution(env.chain, 'alice', SIGNER)).records).toMatchObject({ ok: false, problem: 'addressRoleMissing' })
    state.resourceRoles = { [addressResource(ETH_COIN_TYPE).toString()]: { [me]: ROLE_SET_ADDRESS } }
    expect((await attribution(env.chain, 'alice', SIGNER)).records.ok).toBe(true)
    state.roles = { [me]: ROLE_SET_ADDRESS }
    state.resourceRoles = { [textResource(NOT_BEFORE_KEY).toString()]: { [me]: ROLE_SET_TEXT } }
    expect((await attribution(env.chain, 'alice', SIGNER)).records.ok).toBe(true)
    state.resourceRoles = { [textResource('some-other-key').toString()]: { [me]: ROLE_SET_TEXT } }
    expect((await attribution(env.chain, 'alice', SIGNER)).records).toMatchObject({ ok: false, problem: 'textRoleMissing' })
  })

  it('refuses a resolver the factory does not vouch for, and one whose roles cannot be read', async () => {
    const foreign = signInChain()
    foreign.world.resolvers[RESOLVER]!.foreign = true
    expect((await attribution(foreign.chain, 'alice', SIGNER)).records).toMatchObject({ ok: false, problem: 'notPermissionedResolver' })
    const broken = signInChain()
    broken.world.resolvers[RESOLVER]!.rolesRevert = true
    expect((await attribution(broken.chain, 'alice', SIGNER)).records).toMatchObject({ ok: false, problem: 'unreadable' })
    const none = signInChain()
    none.world.names['alice']!.resolver = undefined
    expect((await attribution(none.chain, 'alice', SIGNER)).records).toEqual({ ok: false, resolver: null, problem: 'noResolver' })
  })

  it('stops the ID site from signing in as a name whose records are someone else\'s', async () => {
    const env = gifted()
    const parsed = parseRequest(`#/connect?v=1&return=${encodeURIComponent(`${ORIGIN}/callback`)}&nonce=k3Jf92LmQp0xZ7aT`)
    if (!parsed.ok) throw new Error(parsed.reason)
    await expect(signIn({ request: parsed.request, chain: env.chain, address: SIGNER, labels: ['alice'], now: NOW }))
      .rejects.toMatchObject({ name: 'ConnectError', reason: 'recordsNotHeld', detail: 'alice', problem: 'textRoleMissing' })
  })

  it('refuses a sign-in the holder signed anyway, and each action, as recordsNotHeld', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain, withKey: true })
    expect(await verify(env, flow)).toMatchObject({ ok: true })
    env.world.resolvers[RESOLVER]!.roles = { [GIVER.toLowerCase()]: 17n }
    expect(await verify(env, flow)).toEqual({ ok: false, failure: 'recordsNotHeld', detail: 'textRoleMissing', name: 'alice.v1.orivonid.eth' })
    const payload = utf8('act')
    expect(await verifyAction({ signIn: flow.response, payload, signature: await flow.key.sign(payload), origin: ORIGIN, chain: env.chain, now: NOW + 5 }))
      .toMatchObject({ ok: false, failure: 'recordsNotHeld' })
  })

  it('will not build the call that ends all sign-ins when the holder cannot send it', async () => {
    const env = gifted()
    await expect(revokeAllCall(env.chain, 'alice', NOW)).rejects.toMatchObject({ name: 'RevokeError', reason: 'recordsNotHeld', detail: 'textRoleMissing' })
    const mine = signInChain()
    expect(await revokeAllCall(mine.chain, 'alice', NOW)).toMatchObject({ to: RESOLVER })
    expect(await revokeAllCall(mine.chain, 'alice', NOW, { holder: SIGNER })).toMatchObject({ to: RESOLVER })
  })

  it('explains in words, with the remedy, why a held name is not offered', async () => {
    const found = await attribution(gifted().chain, 'alice', SIGNER)
    const why = whyNotOffered(found)
    expect(why).toMatchObject({ reason: 'recordsNotHeld' })
    expect(why?.words).toContain('You cannot change the records of alice.v1.orivonid.eth')
    expect(why?.remedy).toBe('Choose “Move to your own resolver” for alice.v1.orivonid.eth in My IDs, then sign in.')
    expect(whyNotOffered(await attribution(signInChain().chain, 'alice', SIGNER))).toBeNull()
    for (const problem of ['notPermissionedResolver', 'textRoleMissing', 'addressRoleMissing', 'unreadable', 'noResolver']) {
      const words = recordsNotHeldWords('alice.v1.orivonid.eth', problem)
      expect(words.words, problem).toContain('alice.v1.orivonid.eth')
      expect(words.remedy.length, problem).toBeGreaterThan(5)
    }
  })

  it('names the other clauses with words, in the order they fail', async () => {
    const taken = signInChain()
    taken.world.names['alice']!.owner = GIVER
    expect(whyNotOffered(await attribution(taken.chain, 'alice', SIGNER))).toMatchObject({ reason: 'owner', remedy: null })
    const shared = signInChain()
    shared.world.names['alice']!.roleCount = (1n << 20n) + 1n
    expect(whyNotOffered(await attribution(shared.chain, 'alice', SIGNER))).toMatchObject({ reason: 'roles' })
    const elsewhere = signInChain()
    elsewhere.world.resolvers[RESOLVER]!.addr = GIVER
    expect(whyNotOffered(await attribution(elsewhere.chain, 'alice', SIGNER))).toMatchObject({ reason: 'forward' })
  })
})

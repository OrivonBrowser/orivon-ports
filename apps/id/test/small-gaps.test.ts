// Small gaps in revocation, the roles clause and reading the answer. Each test keeps the scenario of the weakness and
// asserts it is closed.
//
// L4: a sign-in may be Issued At up to CLOCK_SKEW (300 s) after the verifier's clock, and revocation compares the
//     record with Issued At, so "End all sign-ins" writes the time plus CLOCK_SKEW.
// N1: the roles clause (b) compares two reads, and a read that fails is its own problem, never zero.
// N2: the answer in a fragment is read whole or called malformed; `completeSignIn` keeps the request until the
//     chain has answered, and a nonce still works once.

import { describe, expect, it } from 'vitest'
import { decode, selector } from '../site/sdk/abi.js'
import { toHex } from '../site/sdk/bytes.js'
import type { Chain } from '../site/sdk/chain.js'
import { completeSignIn, loadPending, revokeAllCall } from '../site/sdk/connect.js'
import { readAnswer } from '../site/sdk/pending.js'
import { attribution } from '../site/sdk/orivonid.js'
import { CLOCK_SKEW, encodeResponse, NOT_BEFORE_KEY } from '../site/sdk/protocol.js'
import { verifySignIn } from '../site/sdk/verify.js'
import { requestOn, runFlow } from './support/signin-flow.ts'
import { NOT_BEFORE, NOW, ORIGIN, RESOLVER, signInChain, SIGNER } from './support/signin-world.ts'

describe('L4: revocation and the clock skew allowance', () => {
  it('writes the time plus the allowance, so a sign-in issued 299 s ahead does not outlive "End all sign-ins"', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain, withKey: true, now: NOW + 299 })
    const call = await revokeAllCall(env.chain, 'alice', NOW)
    const [, key, value] = decode(['bytes', 'string', 'string'], call.data.subarray(4)) as [Uint8Array, string, string]
    expect([key, value]).toEqual([NOT_BEFORE_KEY, String(NOW + CLOCK_SKEW)])
    const resolver = env.world.resolvers[RESOLVER]
    if (resolver === undefined) throw new Error('no resolver')
    resolver.texts = { [NOT_BEFORE]: value }
    const result = await verifySignIn(flow.response, { chain: env.chain, origin: ORIGIN, nonce: flow.nonce, key: flow.key.hex, ttl: 2_592_000, now: NOW })
    expect(result).toMatchObject({ ok: false, failure: 'revoked', detail: String(NOW + CLOCK_SKEW) })
  })

  it('lets a sign-in made after the allowance stand', async () => {
    const env = signInChain()
    const later = NOW + CLOCK_SKEW + 1
    const resolver = env.world.resolvers[RESOLVER]
    if (resolver === undefined) throw new Error('no resolver')
    resolver.texts = { [NOT_BEFORE]: String(NOW + CLOCK_SKEW) }
    const flow = await runFlow({ chain: env.chain, withKey: true, now: later })
    expect(await verifySignIn(flow.response, { chain: env.chain, origin: ORIGIN, nonce: flow.nonce, key: flow.key.hex, ttl: 2_592_000, now: later })).toMatchObject({ ok: true })
  })
})

describe('N1: the roles clause when a role read fails', () => {
  const failing = (env: ReturnType<typeof signInChain>, selectors: string[], answer: 'revert' | 'empty') => {
    const fail = new Set(selectors.map((signature) => toHex(selector(signature))))
    return {
      ...env.chain,
      call: async (tx: { to?: string, data?: Uint8Array }, ...rest: unknown[]) => fail.has(toHex((tx.data ?? new Uint8Array(4)).subarray(0, 4)))
        ? { data: answer === 'revert' ? null : new Uint8Array(0), revert: answer === 'revert' ? new Uint8Array(0) : null, offchainLookup: null }
        : await (env.chain.call as (...args: unknown[]) => Promise<unknown>)(tx, ...rest)
    } as unknown as Chain
  }

  it.each([
    ['both reads revert', ['roleCount(uint256)', 'roles(uint256,address)'], 'revert'],
    ['both reads answer nothing', ['roleCount(uint256)', 'roles(uint256,address)'], 'empty'],
    ['the count reverts', ['roleCount(uint256)'], 'revert'],
    ['the holder\'s roles revert', ['roles(uint256,address)'], 'revert']
  ] as const)('fails closed with its own problem when %s, never as 0 == 0', async (_name, selectors, answer) => {
    const env = signInChain()
    const chain = failing(env, [...selectors], answer)
    const found = await attribution(chain, 'alice', SIGNER)
    expect(found.roles).toMatchObject({ ok: false, problem: 'rolesUnreadable' })
    expect(found.ok).toBe(false)
    const flow = await runFlow({ chain: env.chain })
    expect(await verifySignIn(flow.response, { chain, origin: ORIGIN, nonce: flow.nonce, key: null, now: NOW + 5 }))
      .toEqual({ ok: false, failure: 'notAttributed', detail: 'rolesUnreadable', name: 'alice.v1.orivonid.eth' })
  })

  it('still reads a name nobody holds as zero roles of zero (an answer, not a failure)', async () => {
    const env = signInChain()
    expect((await attribution(env.chain, 'nobody', SIGNER)).roles).toEqual({ ok: true, roleCount: 0n, roles: 0n, problem: null })
  })
})

describe('N2: reading and completing the answer', () => {
  it('reads the answer a fragment carries, whole, and calls one it cannot read malformed', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain })
    expect(readAnswer(`#orivonid=${encodeResponse(flow.response)}`)).toEqual({ kind: 'response', response: flow.response })
    expect(readAnswer('#orivonid-error=cancelled&state=s')).toEqual({ kind: 'error', error: 'cancelled', state: 's' })
    expect(readAnswer('#orivonid=%%%')).toEqual({ kind: 'malformed' })
  })

  it('keeps the request when the chain cannot answer, so the same answer can be tried again', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain })
    const pending = loadPending(flow.storage)
    expect(pending).not.toBeNull()
    env.down.value = true
    expect(await completeSignIn(flow.response, { chain: env.chain, now: NOW, storage: flow.storage })).toMatchObject({ ok: false, failure: 'chainUnavailable' })
    expect(loadPending(flow.storage)).toEqual(pending)
    env.down.value = false
    expect(await completeSignIn(flow.response, { chain: env.chain, now: NOW, storage: flow.storage })).toMatchObject({ ok: true, address: SIGNER })
  })

  it('uses a nonce once after a success: the same answer, again, finds no request', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain })
    expect(await completeSignIn(flow.response, { chain: env.chain, now: NOW, storage: flow.storage })).toMatchObject({ ok: true })
    expect(loadPending(flow.storage)).toBeNull()
    expect(await completeSignIn(flow.response, { chain: env.chain, now: NOW, storage: flow.storage })).toEqual({ ok: false, failure: 'noPendingRequest' })
  })

  it('lets only one of two presentations at once succeed', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain })
    const results = await Promise.all([
      completeSignIn(flow.response, { chain: env.chain, now: NOW, storage: flow.storage }),
      completeSignIn(flow.response, { chain: env.chain, now: NOW, storage: flow.storage })
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.find((result) => !result.ok)).toEqual({ ok: false, failure: 'noPendingRequest' })
    expect(loadPending(flow.storage)).toBeNull()
  })

  it('does not put back a request that a definite answer used up', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain })
    expect(await completeSignIn({ ...flow.response, address: '0x' + '11'.repeat(20) }, { chain: env.chain, now: NOW, storage: flow.storage })).toMatchObject({ ok: false })
    expect(loadPending(flow.storage)).toBeNull()
  })

  it('does not put a request back over a newer one made while the chain was being asked', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain })
    env.down.value = true
    const attempt = completeSignIn(flow.response, { chain: env.chain, now: NOW, storage: flow.storage })
    await requestOn(flow.storage, {}, { origin: ORIGIN, now: NOW })
    const newer = loadPending(flow.storage)
    expect(newer?.nonce).not.toBe(flow.nonce)
    expect(await attempt).toMatchObject({ failure: 'chainUnavailable' })
    expect(loadPending(flow.storage)).toEqual(newer)
  })

  it('keeps the request when the call itself was made wrongly', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain })
    await expect(completeSignIn(flow.response, { chain: env.chain, now: NOW + 0.5, storage: flow.storage })).rejects.toThrow('whole seconds')
    expect(loadPending(flow.storage)).not.toBeNull()
  })
})

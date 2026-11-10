import { afterAll, describe, expect, it, vi } from 'vitest'
import { toHex, utf8 } from '../site/sdk/bytes.js'
import type { Chain } from '../site/sdk/chain.js'
import { eip1193Chain } from '../site/sdk/chain-eip1193.js'
import { revokeAllCall } from '../site/sdk/connect.js'
import { keccak256 } from '../site/sdk/keccak.js'
import { ADDRESSES, labelId, readContract } from '../site/sdk/orivonid.js'
import { buildMessage, hashMessage } from '../site/sdk/siwe.js'
import { CLOCK_SKEW, signInFields, type SignInResponse } from '../site/sdk/protocol.js'
import { verifyAction, verifySignIn } from '../site/sdk/verify.js'
import { anvilRpc, FORK_BLOCK, startFork } from './support/anvil.ts'
import { rpcProvider } from './support/rpc-provider.ts'
import { buyName, freshAccount, fund, send, setRecords, type Sale } from './support/sale.ts'
import { addressOf, signDigest } from './support/secp256k1.ts'
import { runFlow } from './support/signin-flow.ts'

// A person with a key the test holds, a username bought for real from the deployed registrar on a mainnet fork,
// and a site that signs them in: the ID site's code and the relying site's code run against the fork's own
// `ecrecover` precompile, registry and resolver. Needs anvil and a public node that keeps state at the block;
// skips otherwise.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })
const fork = await startFork()
const reason = 'skip' in fork ? fork.skip : null
if (reason !== null) console.warn(`[fork tests skipped] ${reason}`)
afterAll(async () => { if (!('skip' in fork)) await fork.stop() })

const ORIGIN = 'https://app.example.org'
const KEY_A = keccak256(utf8('orivon-id-test:signin-person-a'))
const KEY_B = keccak256(utf8('orivon-id-test:signin-person-b'))
const PERSON_A = addressOf(KEY_A)
const PERSON_B = addressOf(KEY_B)
const DAI = 10n ** 18n

/** The page's chain, but with a wallet whose key the test holds: anvil has no accounts to sign for. */
function wallet (chain: Chain, key: Uint8Array, address: string): Chain {
  return { ...chain, addresses: async () => [address], signMessage: async (message) => signDigest(key, hashMessage(new TextDecoder().decode(message))) }
}

describe.skipIf(reason !== null)(`a sign-in on a mainnet fork at block ${FORK_BLOCK}`, () => {
  const url = 'skip' in fork ? '' : fork.url
  const node = eip1193Chain(rpcProvider(url))
  const calls: { to: string, selector: string }[] = []
  const chain = { ...node, call: async (...args: Parameters<Chain['call']>) => {
    calls.push({ to: (args[0].to ?? '').toLowerCase(), selector: toHex(args[0].data?.subarray(0, 4) ?? new Uint8Array(4)) })
    return await node.call(...args)
  } } as Chain
  const personA = wallet(chain, KEY_A, PERSON_A)
  const now = () => Math.floor(Date.now() / 1000)
  const state: { sale?: Sale } = {}

  it('has a person with an address they hold the key to, a name bought for it, and its address record set', async () => {
    expect(await node.getCode(PERSON_A)).toHaveLength(0)
    await fund(url, node, PERSON_A, 100n * DAI)
    state.sale = await buyName(url, node, 'signin-alice', PERSON_A)
    await setRecords(node, state.sale, {})
  })

  it('verifies a sign-in made without a key, end to end through the chain: the precompile, the registry and the resolver', async () => {
    const flow = await runFlow({ chain: personA, labels: ['signin-alice'], now: now(), address: PERSON_A })
    calls.length = 0
    const result = await verifySignIn(flow.response, { chain, origin: ORIGIN, nonce: flow.nonce, key: null, now: now() })
    expect(result).toMatchObject({ ok: true, address: PERSON_A, names: ['signin-alice.v1.orivonid.eth'], key: null, via: 'ecrecover' })
    expect(calls.some((call) => call.to === '0x0000000000000000000000000000000000000001')).toBe(true)
  })

  it('verifies a delegated key, and an action signed by it', async () => {
    const at = now()
    const flow = await runFlow({ chain: personA, labels: ['signin-alice'], withKey: true, ttl: 2_592_000, now: at, address: PERSON_A })
    const signed = await verifySignIn(flow.response, { chain, origin: ORIGIN, nonce: flow.nonce, key: flow.key.hex, ttl: 2_592_000, now: at })
    expect(signed).toMatchObject({ ok: true, key: flow.key.hex, notAfter: at + 2_592_000 })
    const payload = utf8('{"post":"hello","n":1}')
    expect(await verifyAction({ signIn: flow.response, payload, signature: await flow.key.sign(payload), origin: ORIGIN, chain, now: now() })).toMatchObject({ ok: true, address: PERSON_A })
    expect(await verifyAction({ signIn: flow.response, payload: utf8('{"post":"bye"}'), signature: await flow.key.sign(payload), origin: ORIGIN, chain, now: now() })).toMatchObject({ failure: 'badActionSignature' })
  })

  it('refuses a wrong nonce, origin, domain and signer, and an expired sign-in', async () => {
    const at = now()
    const flow = await runFlow({ chain: personA, labels: ['signin-alice'], now: at, address: PERSON_A })
    const base = { chain, origin: ORIGIN, nonce: flow.nonce, key: null, now: at }
    expect(await verifySignIn(flow.response, { ...base, nonce: 'abcdefgh12345678' })).toMatchObject({ failure: 'wrongNonce' })
    expect(await verifySignIn(flow.response, { ...base, origin: 'https://other.example.org' })).toMatchObject({ failure: 'wrongAudience' })
    expect(await verifySignIn(flow.response, { ...base, now: at + 600 })).toMatchObject({ failure: 'expired' })
    const signedBy = (key: Uint8Array, domain: string): SignInResponse => {
      const fields = { ...signInFields({ address: PERSON_A, origin: ORIGIN, nonce: flow.nonce, issuedAt: at, expiresAt: at + 600, labels: ['signin-alice'], resolvers: [state.sale?.resolver ?? ''], key: null }), domain }
      const message = buildMessage(fields)
      return { v: 1, message, signature: '0x' + toHex(signDigest(key, hashMessage(message))), address: PERSON_A, names: ['signin-alice.v1.orivonid.eth'] }
    }
    expect(await verifySignIn(signedBy(KEY_A, 'id.orivonstack.eth'), base)).toMatchObject({ ok: true })
    expect(await verifySignIn(signedBy(KEY_A, 'evil.example'), base)).toMatchObject({ failure: 'wrongDomain' })
    expect(await verifySignIn(signedBy(KEY_B, 'id.orivonstack.eth'), base)).toMatchObject({ failure: 'badSignature' })
  })

  it('stops honouring sign-ins made before the owner sets the record, and honours one made after it', async () => {
    const at = now()
    const before = await runFlow({ chain: personA, labels: ['signin-alice'], withKey: true, now: at, address: PERSON_A })
    const payload = utf8('act')
    const signature = await before.key.sign(payload)
    expect(await verifyAction({ signIn: before.response, payload, signature, origin: ORIGIN, chain, now: at })).toMatchObject({ ok: true })
    const revocation = await revokeAllCall(chain, 'signin-alice', at + 5)
    expect(revocation.to).toBe(state.sale?.resolver)
    const until = at + 5 + CLOCK_SKEW
    const hash = await node.sendTransaction({ from: PERSON_A, to: revocation.to, data: revocation.data })
    expect((await node.waitForReceipt(hash, { intervalMs: 50 })).status).toBe(1)
    expect(await verifyAction({ signIn: before.response, payload, signature, origin: ORIGIN, chain, now: at })).toMatchObject({ ok: false, failure: 'revoked', detail: String(until) })
    expect(await verifySignIn(before.response, { chain, origin: ORIGIN, nonce: before.nonce, key: before.key.hex, ttl: 2_592_000, now: at })).toMatchObject({ failure: 'revoked' })
    const soon = await runFlow({ chain: personA, labels: ['signin-alice'], withKey: true, now: at + 6, address: PERSON_A })
    expect(await verifyAction({ signIn: soon.response, payload, signature: await soon.key.sign(payload), origin: ORIGIN, chain, now: at + 6 })).toMatchObject({ ok: false, failure: 'revoked' })
    const after = await runFlow({ chain: personA, labels: ['signin-alice'], withKey: true, now: until + 1, address: PERSON_A })
    expect(await verifyAction({ signIn: after.response, payload, signature: await after.key.sign(payload), origin: ORIGIN, chain, now: until + 1 })).toMatchObject({ ok: true })
  })

  it('stops honouring a sign-in once the name is transferred', async () => {
    const at = now() + 2 * CLOCK_SKEW
    const flow = await runFlow({ chain: personA, labels: ['signin-alice'], withKey: true, now: at, address: PERSON_A })
    const payload = utf8('act')
    const signature = await flow.key.sign(payload)
    expect(await verifyAction({ signIn: flow.response, payload, signature, origin: ORIGIN, chain, now: at })).toMatchObject({ ok: true })
    const other = freshAccount('signin-recipient')
    const [tokenId] = await readContract(node, ADDRESSES.r1, 'getTokenId(uint256)', [labelId('signin-alice')], ['uint256'])
    await send(node, PERSON_A, ADDRESSES.r1, 'safeTransferFrom(address,address,uint256,uint256,bytes)', [PERSON_A, other, tokenId, 1n, '0x'])
    expect(await verifyAction({ signIn: flow.response, payload, signature, origin: ORIGIN, chain, now: at })).toMatchObject({ ok: false, failure: 'notAttributed', detail: 'owner' })
    expect(await verifySignIn(flow.response, { chain, origin: ORIGIN, nonce: flow.nonce, key: flow.key.hex, ttl: 2_592_000, now: at })).toMatchObject({ failure: 'notAttributed' })
  })
})

describe.skipIf(reason !== null)('an account that delegates to code by EIP-7702', () => {
  const url = 'skip' in fork ? '' : fork.url
  const node = eip1193Chain(rpcProvider(url))
  const calls: string[] = []
  const chain = { ...node, call: async (...args: Parameters<Chain['call']>) => {
    calls.push(toHex(args[0].data?.subarray(0, 4) ?? new Uint8Array(4)))
    return await node.call(...args)
  } } as Chain
  const personB = wallet(chain, KEY_B, PERSON_B)
  const now = () => Math.floor(Date.now() / 1000)

  it('still proves its own key by ecrecover, without asking the code it delegates to', async () => {
    await fund(url, node, PERSON_B, 100n * DAI)
    const sale = await buyName(url, node, 'signin-bob', PERSON_B)
    await setRecords(node, sale, {})
    await anvilRpc(url, 'anvil_setCode', [PERSON_B, '0xef0100' + ADDRESSES.registrar.slice(2).toLowerCase()])
    expect(toHex(await node.getCode(PERSON_B))).toBe('ef0100' + ADDRESSES.registrar.slice(2).toLowerCase())
    const flow = await runFlow({ chain: personB, labels: ['signin-bob'], now: now(), address: PERSON_B })
    calls.length = 0
    expect(await verifySignIn(flow.response, { chain, origin: ORIGIN, nonce: flow.nonce, key: null, now: now() })).toMatchObject({ ok: true, address: PERSON_B, via: 'ecrecover' })
    expect(calls.includes('1626ba7e')).toBe(false)
  })

  it('does not accept a signature by another key just because it has code: the code is asked, and it does not vouch', async () => {
    const at = now()
    const flow = await runFlow({ chain: personB, labels: ['signin-bob'], now: at, address: PERSON_B })
    const forged = { ...flow.response, signature: '0x' + toHex(signDigest(KEY_A, hashMessage(flow.response.message))) }
    calls.length = 0
    expect(await verifySignIn(forged, { chain, origin: ORIGIN, nonce: flow.nonce, key: null, now: at })).toMatchObject({ ok: false, failure: 'badSignature' })
    expect(calls.includes('1626ba7e')).toBe(true)
  })
})

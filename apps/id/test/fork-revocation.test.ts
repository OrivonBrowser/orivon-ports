// Revocation and attribution on a mainnet fork (findings M2, M3, and L1's secp256k1 half), against the deployed
// registry, factory and PermissionedResolver. Each test keeps the scenario of the attack and asserts it fails. Needs
// anvil and a public node that keeps state at the pinned block; skips otherwise.
//
// M2: a sign-in is bound to the resolver its username was signed with, so a new resolver ends it; a transfer away and
//     back still revives a sign-in that was not revoked (documented), and never one that was.
// M3: a name attributed to its holder while its records live on a resolver someone else controls is not offered, not
//     signed in as, and the holder is not told to end sign-ins on a resolver they cannot write.
// L1: the real ecrecover precompile accepts the high-s twin of a signature; the verifier does not.

import { afterAll, describe, expect, it, vi } from 'vitest'
import { concat, fromHex, toHex, utf8 } from '../site/sdk/bytes.js'
import type { Chain } from '../site/sdk/chain.js'
import { eip1193Chain } from '../site/sdk/chain-eip1193.js'
import { revokeAllCall } from '../site/sdk/connect.js'
import { dnsEncode } from '../site/sdk/ens.js'
import { keccak256 } from '../site/sdk/keccak.js'
import { ADDRESSES, attribution, labelId, nameOf, readContract } from '../site/sdk/orivonid.js'
import { buildMessage, hashMessage } from '../site/sdk/siwe.js'
import { signInFields } from '../site/sdk/protocol.js'
import { verifyAction, verifySignIn } from '../site/sdk/verify.js'
import { anvilRpc, FORK_BLOCK, startFork } from './support/anvil.ts'
import { rpcProvider } from './support/rpc-provider.ts'
import { ALL_RESOLVER_ROLES, buyName, freshAccount, fund, send, setRecords } from './support/sale.ts'
import { addressOf, signDigest } from './support/secp256k1.ts'
import { runFlow } from './support/signin-flow.ts'

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })
const fork = await startFork()
const reason = 'skip' in fork ? fork.skip : null
if (reason !== null) console.warn(`[fork tests skipped] ${reason}`)
afterAll(async () => { if (!('skip' in fork)) await fork.stop() })

const ORIGIN = 'https://app.example.org'
const DAI = 10n ** 18n
const K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const KEY_P = keccak256(utf8('orivon-id-review:person'))
const KEY_R = keccak256(utf8('orivon-id-review:recipient'))
const PERSON = addressOf(KEY_P)
const RECIPIENT = addressOf(KEY_R)
const KEY_S = keccak256(utf8('orivon-id-review:high-s'))
const SIGNER = addressOf(KEY_S)
const GIVER = freshAccount('review-giver')
const OTHER = freshAccount('review-other')

function wallet (chain: Chain, key: Uint8Array, address: string): Chain {
  return { ...chain, addresses: async () => [address], signMessage: async (message) => signDigest(key, hashMessage(new TextDecoder().decode(message))) }
}

describe.skipIf(reason !== null)(`revocation and attribution on a mainnet fork at block ${FORK_BLOCK}`, () => {
  const url = 'skip' in fork ? '' : fork.url
  const chain = eip1193Chain(rpcProvider(url))
  const now = () => Math.floor(Date.now() / 1000)
  const tokenOf = async (label: string) => (await readContract(chain, ADDRESSES.r1, 'getTokenId(uint256)', [labelId(label)], ['uint256']))[0] as bigint
  const gas = async (account: string) => {
    await anvilRpc(url, 'anvil_impersonateAccount', [account])
    await anvilRpc(url, 'anvil_setBalance', [account, '0x' + (10n ** 20n).toString(16)])
  }
  const transfer = async (label: string, from: string, to: string) =>
    await send(chain, from, ADDRESSES.r1, 'safeTransferFrom(address,address,uint256,uint256,bytes)', [from, to, await tokenOf(label), 1n, '0x'])
  const sendCall = async (from: string, call: { to: string, data: Uint8Array }) => {
    const hash = await chain.sendTransaction({ from, to: call.to, data: call.data })
    expect((await chain.waitForReceipt(hash, { intervalMs: 50 })).status).toBe(1)
  }
  const kept: { flow?: Awaited<ReturnType<typeof runFlow>> } = {}

  it('M2: a revoked delegation stays revoked when the holder points the name at a new resolver: the sign-in is bound to the one it was signed with', async () => {
    await fund(url, chain, PERSON, 100n * DAI)
    const sale = await buyName(url, chain, 'rv-revive', PERSON)
    await setRecords(chain, sale, {})
    const at = now()
    const flow = await runFlow({ chain: wallet(chain, KEY_P, PERSON), labels: ['rv-revive'], withKey: true, now: at, address: PERSON })
    expect(flow.response.message).toContain(`#${sale.resolver.toLowerCase()}`)
    const payload = utf8('act')
    const signature = await flow.key.sign(payload)
    const act = async () => await verifyAction({ signIn: flow.response, payload, signature, origin: ORIGIN, chain, now: now() })
    expect(await act()).toMatchObject({ ok: true })

    await sendCall(PERSON, await revokeAllCall(chain, 'rv-revive', at + 5))
    expect(await act()).toMatchObject({ ok: false, failure: 'revoked' })

    const [second] = await readContract(chain, ADDRESSES.verifiableFactory, 'predictProxyAddress(address,uint256)', [PERSON, 2n], ['address'])
    const init = await import('../site/sdk/abi.js').then(({ encodeCall }) => encodeCall('initialize((address,uint256)[],bytes[])', [[[PERSON, ALL_RESOLVER_ROLES]], []]))
    await send(chain, PERSON, ADDRESSES.verifiableFactory, 'deployProxy(address,uint256,bytes)', [ADDRESSES.resolverImplementation, 2n, init])
    await send(chain, PERSON, second as string, 'setAddress(bytes,uint256,bytes)', [dnsEncode(nameOf('rv-revive')), 60n, fromHex(PERSON)])
    await send(chain, PERSON, ADDRESSES.r1, 'setResolver(uint256,address)', [await tokenOf('rv-revive'), second])
    expect(await act()).toMatchObject({ ok: false, failure: 'resolverChanged', detail: second, name: nameOf('rv-revive') })
    expect(await attribution(chain, 'rv-revive', PERSON)).toMatchObject({ ok: true, records: { ok: true, resolver: second } })
    kept.flow = flow
  })

  it('M2: a transfer away ends a sign-in, and a transfer back revives it only if it was not revoked: revoke before transferring', async () => {
    const at = now()
    const flow = await runFlow({ chain: wallet(chain, KEY_P, PERSON), labels: ['rv-revive'], withKey: true, now: at, address: PERSON })
    const payload = utf8('act-2')
    const signature = await flow.key.sign(payload)
    const act = async () => await verifyAction({ signIn: flow.response, payload, signature, origin: ORIGIN, chain, now: now() })
    expect(await act()).toMatchObject({ ok: true })
    await gas(OTHER)
    await transfer('rv-revive', PERSON, OTHER)
    expect(await act()).toMatchObject({ ok: false, failure: 'notAttributed', detail: 'owner' })
    await transfer('rv-revive', OTHER, PERSON)
    expect(await act()).toMatchObject({ ok: true, address: PERSON })

    await sendCall(PERSON, await revokeAllCall(chain, 'rv-revive', at))
    expect(await act()).toMatchObject({ ok: false, failure: 'revoked' })
    await transfer('rv-revive', PERSON, OTHER)
    await transfer('rv-revive', OTHER, PERSON)
    expect(await act()).toMatchObject({ ok: false, failure: 'revoked' })
    expect(kept.flow).toBeDefined()
  })

  it('M3: a gifted name whose records the giver controls is not attributed to its holder, and nothing signs in as it', async () => {
    await fund(url, chain, GIVER, 100n * DAI)
    const sale = await buyName(url, chain, 'rv-gift', GIVER)
    const dns = dnsEncode(nameOf('rv-gift'))
    await send(chain, GIVER, sale.resolver, 'setAddress(bytes,uint256,bytes)', [dns, 60n, fromHex(RECIPIENT)])
    await transfer('rv-gift', GIVER, RECIPIENT)
    const found = await attribution(chain, 'rv-gift', RECIPIENT)
    expect(found).toMatchObject({
      ok: false, owner: { ok: true }, roles: { ok: true }, forward: { ok: true, resolver: sale.resolver }, records: { ok: false, resolver: sale.resolver, problem: 'textRoleMissing' }
    })

    // The ID site does not sign.
    const at = now()
    await expect(runFlow({ chain: wallet(chain, KEY_R, RECIPIENT), labels: ['rv-gift'], withKey: true, now: at, address: RECIPIENT }))
      .rejects.toMatchObject({ reason: 'recordsNotHeld', detail: 'rv-gift' })

    // A sign-in the recipient made some other way is refused where it is checked.
    const fields = signInFields({ address: RECIPIENT, origin: ORIGIN, nonce: 'kN3Jf92LmQp0xZ7aT', issuedAt: at, expiresAt: at + 600, labels: ['rv-gift'], resolvers: [sale.resolver], key: null })
    const message = buildMessage(fields)
    const response = { v: 1 as const, message, signature: '0x' + toHex(signDigest(KEY_R, hashMessage(message))), address: RECIPIENT, names: [nameOf('rv-gift')] }
    expect(await verifySignIn(response, { chain, origin: ORIGIN, nonce: 'kN3Jf92LmQp0xZ7aT', key: null, now: at }))
      .toEqual({ ok: false, failure: 'recordsNotHeld', detail: 'textRoleMissing', name: nameOf('rv-gift') })

    // The holder is not handed a call that would revert on the giver's resolver.
    await expect(revokeAllCall(chain, 'rv-gift', at)).rejects.toMatchObject({ name: 'RevokeError', reason: 'recordsNotHeld' })
  })

  it('M3: the holder points the name at their own resolver and signs in again', async () => {
    await gas(RECIPIENT)
    const [own] = await readContract(chain, ADDRESSES.verifiableFactory, 'predictProxyAddress(address,uint256)', [RECIPIENT, 1n], ['address'])
    const init = await import('../site/sdk/abi.js').then(({ encodeCall }) => encodeCall('initialize((address,uint256)[],bytes[])', [[[RECIPIENT, ALL_RESOLVER_ROLES]], []]))
    await send(chain, RECIPIENT, ADDRESSES.verifiableFactory, 'deployProxy(address,uint256,bytes)', [ADDRESSES.resolverImplementation, 1n, init])
    await send(chain, RECIPIENT, own as string, 'setAddress(bytes,uint256,bytes)', [dnsEncode(nameOf('rv-gift')), 60n, fromHex(RECIPIENT)])
    await send(chain, RECIPIENT, ADDRESSES.r1, 'setResolver(uint256,address)', [await tokenOf('rv-gift'), own])
    expect(await attribution(chain, 'rv-gift', RECIPIENT)).toMatchObject({ ok: true, records: { ok: true, resolver: own } })
    const at = now()
    const flow = await runFlow({ chain: wallet(chain, KEY_R, RECIPIENT), labels: ['rv-gift'], withKey: true, now: at, address: RECIPIENT })
    const payload = utf8('act')
    expect(await verifyAction({ signIn: flow.response, payload, signature: await flow.key.sign(payload), origin: ORIGIN, chain, now: at })).toMatchObject({ ok: true, address: RECIPIENT })
    const revocation = await revokeAllCall(chain, 'rv-gift', at)
    expect(revocation.to).toBe(own)
    await sendCall(RECIPIENT, revocation)
    expect(await verifyAction({ signIn: flow.response, payload, signature: await flow.key.sign(payload), origin: ORIGIN, chain, now: at })).toMatchObject({ ok: false, failure: 'revoked' })
  })

  it('L1: the real ecrecover precompile accepts the high-s twin of a sign-in signature, and the verifier refuses it', async () => {
    await fund(url, chain, SIGNER, 100n * DAI)
    const sale = await buyName(url, chain, 'rv-high-s', SIGNER)
    await setRecords(chain, sale, {})
    const at = now()
    const flow = await runFlow({ chain: wallet(chain, KEY_S, SIGNER), labels: ['rv-high-s'], now: at, address: SIGNER })
    const sig = fromHex(flow.response.signature)
    const s = BigInt('0x' + toHex(sig.subarray(32, 64)))
    const twin = concat(sig.subarray(0, 32), fromHex('0x' + (K1_N - s).toString(16).padStart(64, '0')), Uint8Array.of(sig[64] === 27 ? 28 : 27))
    const asked = { chain, origin: ORIGIN, nonce: flow.nonce, key: null, now: at }
    expect(await verifySignIn(flow.response, asked)).toMatchObject({ ok: true, via: 'ecrecover' })
    expect(await verifySignIn({ ...flow.response, signature: '0x' + toHex(twin) }, asked)).toEqual({ ok: false, failure: 'badSignature', detail: 'highS' })
  })
})

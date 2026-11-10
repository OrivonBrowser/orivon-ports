// The move of a name to its holder's own resolver on a mainnet fork, against the deployed registry, factory and
// PermissionedResolver. The setup is the gift of fork-revocation.test.ts (M3): a name whose giver kept the resolver, so
// the holder cannot sign in with it. The move is run by the same state machine the page runs, through the same
// broadcaster a wallet extension gets. Needs anvil and a public node that keeps state at the pinned block; skips otherwise.

import { afterAll, describe, expect, it, vi } from 'vitest'
import { dnsEncode } from '../site/sdk/ens.js'
import { fromHex, toHex, utf8 } from '../site/sdk/bytes.js'
import { type Chain, ChainError } from '../site/sdk/chain.js'
import { eip1193Chain } from '../site/sdk/chain-eip1193.js'
import { revokeAllCall } from '../site/sdk/connect.js'
import { keccak256 } from '../site/sdk/keccak.js'
import { ADDRESSES, attribution, labelId, nameOf, readContract, records, recordsAt } from '../site/sdk/orivonid.js'
import { signInFields } from '../site/sdk/protocol.js'
import { buildMessage, hashMessage } from '../site/sdk/siwe.js'
import { verifyAction, verifySignIn } from '../site/sdk/verify.js'
import { copyKeys } from '../site/move-model.js'
import { createMove } from '../site/move-flow.js'
import { walletBroadcaster } from '../site/register-send.js'
import { ROLE_SET_RESOLVER, SALT } from '../site/register-tx.js'
import { FORK_BLOCK, startFork } from './support/anvil.ts'
import { rpcProvider } from './support/rpc-provider.ts'
import { buyName, freshAccount, fund, mineSeconds, send } from './support/sale.ts'
import { addressOf, signDigest } from './support/secp256k1.ts'
import { runFlow } from './support/signin-flow.ts'

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 })
const fork = await startFork()
const reason = 'skip' in fork ? fork.skip : null
if (reason !== null) console.warn(`[fork tests skipped] ${reason}`)
afterAll(async () => { if (!('skip' in fork)) await fork.stop() })

const ORIGIN = 'https://app.example.org'
const DAI = 10n ** 18n
const KEY = keccak256(utf8('orivon-id-move:recipient'))
const RECIPIENT = addressOf(KEY)
const GIVER = freshAccount('move-giver')
const OTHER = freshAccount('move-other')
const CONTENTHASH = '0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f'
const TEXTS = { url: 'https://moved.example', description: 'A name that was given away.', 'com.github': 'moved-dev' }

describe.skipIf(reason !== null)(`moving a name to its holder's own resolver on a mainnet fork at block ${FORK_BLOCK}`, () => {
  const url = 'skip' in fork ? '' : fork.url
  const chain = eip1193Chain(rpcProvider(url))
  const now = () => Math.floor(Date.now() / 1000)
  const wallet = (): Chain => ({ ...chain, addresses: async () => [RECIPIENT], signMessage: async (message) => signDigest(KEY, hashMessage(new TextDecoder().decode(message))) })
  const tokenOf = async (label: string) => (await readContract(chain, ADDRESSES.r1, 'getTokenId(uint256)', [labelId(label)], ['uint256']))[0] as bigint
  const ownResolver = async () => (await readContract(chain, ADDRESSES.verifiableFactory, 'predictProxyAddress(address,uint256)', [RECIPIENT, SALT], ['address']))[0] as string

  /** A name bought and set up by the giver, with the giver's records on a resolver of the giver's (one per salt), then given to the recipient. */
  async function gift (label: string, salt = 1n) {
    await fund(url, chain, GIVER, 100n * DAI)
    const sale = await buyName(url, chain, label, GIVER, salt)
    const dns = dnsEncode(nameOf(label))
    await send(chain, GIVER, sale.resolver, 'setAddress(bytes,uint256,bytes)', [dns, 60n, fromHex(RECIPIENT)])
    for (const [key, value] of Object.entries(TEXTS)) await send(chain, GIVER, sale.resolver, 'setText(bytes,string,string)', [dns, key, value])
    await send(chain, GIVER, sale.resolver, 'setContenthash(bytes,bytes)', [dns, fromHex(CONTENTHASH)])
    await send(chain, GIVER, ADDRESSES.r1, 'safeTransferFrom(address,address,uint256,uint256,bytes)', [GIVER, RECIPIENT, await tokenOf(label), 1n, '0x'])
    return sale
  }

  /** A page that has just loaded; `declineAt` makes the wallet refuse that step. */
  function page (declineAt: string | null = null) {
    const steps: string[] = []
    const base = walletBroadcaster(chain)
    const broadcaster = {
      prepare: async (tx: Parameters<typeof base.prepare>[0]) => {
        const step = tx.to === ADDRESSES.verifiableFactory ? 'deploy' : tx.to === ADDRESSES.r1 ? 'resolver' : 'records'
        if (step === declineAt) throw new ChainError('declined', 'the person declined')
        steps.push(step)
        return await base.prepare(tx)
      }
    }
    const flow = createMove({
      chain, broadcaster, keys: copyKeys(), pollMs: 30_000,
      clock: { now: () => Date.now(), sleep: async (ms) => { await mineSeconds(url, Math.ceil(ms / 1000)) } }
    })
    return { flow, steps }
  }

  /** A sign-in the recipient made some other way while the name sat on the giver's resolver. */
  function forged (label: string, resolver: string, nonce: string) {
    const at = now()
    const fields = signInFields({ address: RECIPIENT, origin: ORIGIN, nonce, issuedAt: at, expiresAt: at + 600, labels: [label], resolvers: [resolver], key: null })
    const message = buildMessage(fields)
    return { response: { v: 1 as const, message, signature: '0x' + toHex(signDigest(KEY, hashMessage(message))), address: RECIPIENT, names: [nameOf(label)] }, nonce, at }
  }

  it('moves a gifted name in three transactions and copies its records; a sign-in made before the move ends', async () => {
    await fund(url, chain, RECIPIENT, DAI)
    const sale = await gift('mv-gift')
    expect(await attribution(chain, 'mv-gift', RECIPIENT)).toMatchObject({
      ok: false, owner: { ok: true }, roles: { ok: true }, forward: { ok: true, resolver: sale.resolver }, records: { ok: false, resolver: sale.resolver, problem: 'textRoleMissing' }
    })
    await expect(runFlow({ chain: wallet(), labels: ['mv-gift'], now: now(), address: RECIPIENT })).rejects.toMatchObject({ reason: 'recordsNotHeld', detail: 'mv-gift' })
    const before = forged('mv-gift', sale.resolver, 'kN3Jf92LmQp0xZ7aT')
    expect(await verifySignIn(before.response, { chain, origin: ORIGIN, nonce: before.nonce, key: null, now: before.at })).toMatchObject({ ok: false, failure: 'recordsNotHeld' })

    const { flow, steps } = page()
    const ready = await flow.check('mv-gift', RECIPIENT)
    expect(ready).toMatchObject({ phase: 'ready', plan: { next: 'deploy', started: false, copying: { readable: true, count: 4 } } })
    const done = await flow.run('mv-gift', RECIPIENT, { copy: true })
    expect(done['phase'], JSON.stringify(done['words'])).toBe('done')
    expect(steps).toEqual(['deploy', 'records', 'resolver'])
    console.info(`[move gas on the fork] ${JSON.stringify(done['gas'])}`)
    for (const step of ['deploy', 'records', 'resolver']) expect(done['gas'][step], step).toBeGreaterThan(0)

    const own = await ownResolver()
    expect(await attribution(chain, 'mv-gift', RECIPIENT)).toMatchObject({ ok: true, records: { ok: true, resolver: own }, forward: { ok: true, resolver: own } })
    const moved = await records(chain, 'mv-gift', Object.keys(TEXTS))
    expect(moved).toMatchObject({ resolver: own, addr: RECIPIENT, texts: TEXTS })
    expect(toHex(moved.contenthash as Uint8Array)).toBe(CONTENTHASH.slice(2))

    expect(await verifySignIn(before.response, { chain, origin: ORIGIN, nonce: before.nonce, key: null, now: before.at })).toMatchObject({ ok: false, failure: 'resolverChanged', detail: own })
    const giver = await recordsAt(chain, sale.resolver, 'mv-gift', Object.keys(TEXTS))
    expect(giver).toMatchObject({ addr: RECIPIENT, texts: TEXTS })
  })

  it('signs the holder in after the move, and the holder can end the sign-ins from then on', async () => {
    const own = await ownResolver()
    const at = now()
    const flow = await runFlow({ chain: wallet(), labels: ['mv-gift'], withKey: true, now: at, address: RECIPIENT })
    expect(flow.response.message).toContain(`#${own.toLowerCase()}`)
    expect(await verifySignIn(flow.response, { chain, origin: ORIGIN, nonce: flow.nonce, key: flow.request.key, now: at })).toMatchObject({ ok: true, address: RECIPIENT })
    const payload = utf8('act')
    const act = async () => await verifyAction({ signIn: flow.response, payload, signature: await flow.key.sign(payload), origin: ORIGIN, chain, now: now() })
    expect(await act()).toMatchObject({ ok: true, address: RECIPIENT })
    const call = await revokeAllCall(chain, 'mv-gift', at)
    expect(call.to).toBe(own)
    const hash = await chain.sendTransaction({ from: RECIPIENT, to: call.to, data: call.data })
    expect((await chain.waitForReceipt(hash, { intervalMs: 50 })).status).toBe(1)
    expect(await act()).toMatchObject({ ok: false, failure: 'revoked' })
  })

  it('continues a move a reload interrupted from the first step the chain does not show as done', async () => {
    await gift('mv-resume', 2n)
    const stopped = page('resolver')
    const first = await stopped.flow.run('mv-resume', RECIPIENT, { copy: true })
    expect(first).toMatchObject({ phase: 'failed', step: 'resolver', reason: 'declined' })
    expect(stopped.steps).toEqual(['records'])
    const { flow, steps } = page()
    expect(await flow.check('mv-resume', RECIPIENT)).toMatchObject({ phase: 'ready', plan: { next: 'resolver', started: true } })
    expect((await flow.run('mv-resume', RECIPIENT, { copy: true }))['phase']).toBe('done')
    expect(steps).toEqual(['resolver'])
    expect(await attribution(chain, 'mv-resume', RECIPIENT)).toMatchObject({ ok: true })
  })

  it('refuses a name the address does not hold alone, and sends nothing', async () => {
    await gift('mv-shared', 3n)
    await send(chain, RECIPIENT, ADDRESSES.r1, 'grantRoles(uint256,uint256,address)', [labelId('mv-shared'), ROLE_SET_RESOLVER, OTHER])
    const { flow, steps } = page()
    expect(await attribution(chain, 'mv-shared', RECIPIENT)).toMatchObject({ roles: { ok: false } })
    expect(await flow.check('mv-shared', RECIPIENT)).toMatchObject({ phase: 'refused', reason: 'roles' })
    expect(await flow.run('mv-shared', RECIPIENT, { copy: true })).toMatchObject({ phase: 'refused', reason: 'roles' })
    expect(steps).toEqual([])
  })
})

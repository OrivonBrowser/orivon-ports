// A person with a username, on a chain made of tables: the registry from fake-registry.ts, the `ecrecover`
// precompile and EIP-1271 contracts on top, and a wallet that signs with a key the test holds. Unit tests only.

import { selector, toChecksumAddress } from '../../site/sdk/abi.js'
import { fromHex, toHex, utf8 } from '../../site/sdk/bytes.js'
import { type Chain, ChainError } from '../../site/sdk/chain.js'
import { keccak256 } from '../../site/sdk/keccak.js'
import { hashMessage } from '../../site/sdk/siwe.js'
import { fakeRegistry, type World } from './fake-registry.ts'
import { addressOf, recoverAddress, signDigest } from './secp256k1.ts'

export const PRIVATE_KEY = keccak256(utf8('orivon-id-test:signer'))
export const SIGNER = addressOf(PRIVATE_KEY)
export const ORIGIN = 'https://app.example.org'
export const NOW = 1_793_966_400
export const RESOLVER = toChecksumAddress('0x' + '7e'.repeat(20))

export const NOT_BEFORE = 'eth.orivonstack.id.not-before'

export function aliceWorld (labels: string[] = ['alice'], holder = SIGNER): World {
  const world: World = { names: {}, resolvers: { [RESOLVER]: { addr: holder, texts: {} } }, registrar: {} }
  for (const label of labels) world.names[label] = { owner: holder, resolver: RESOLVER }
  return world
}

export interface Contract { isValidSignature: 'accept' | 'reject' | 'revert' }

export interface SignInChain {
  chain: Chain
  world: World
  /** Contract code per address (lower-case), for `getCode` and EIP-1271. */
  codes: Record<string, Contract | Uint8Array>
  queries: { to: string, selector: string }[]
  /** What the wallet signs with; the address it reports. */
  wallet: { key: Uint8Array, address: string }
  down: { value: boolean }
}

const ECRECOVER = '0x0000000000000000000000000000000000000001'

export function signInChain (world: World = aliceWorld()): SignInChain {
  const registry = fakeRegistry(world)
  const wallet = { key: PRIVATE_KEY, address: SIGNER }
  const codes: SignInChain['codes'] = {}
  const queries: SignInChain['queries'] = []
  const down = { value: false }
  const chain = {
    ...registry.chain,
    addresses: async () => [wallet.address],
    signMessage: async (message: Uint8Array) => signDigest(wallet.key, hashMessage(new TextDecoder().decode(message))),
    getCode: async (address: string) => {
      const entry = codes[address.toLowerCase()]
      return entry === undefined ? new Uint8Array(0) : entry instanceof Uint8Array ? entry : Uint8Array.of(0x60, 0x00)
    },
    call: async (tx: { to?: string, data?: Uint8Array }, ...rest: unknown[]) => {
      const to = (tx.to ?? '').toLowerCase()
      const data = tx.data ?? new Uint8Array(0)
      queries.push({ to, selector: toHex(data.subarray(0, 4)) })
      if (down.value) throw new ChainError('unavailable', 'node is down')
      if (to === ECRECOVER) {
        const recovered = recoverAddress(data.subarray(0, 32), Uint8Array.from([...data.subarray(64, 128), data[63] ?? 0]))
        return { data: recovered === null ? new Uint8Array(0) : fromHex('0x' + '00'.repeat(12) + recovered.slice(2)), revert: null, offchainLookup: null }
      }
      const contract = codes[to]
      if (contract !== undefined && !(contract instanceof Uint8Array) && toHex(data.subarray(0, 4)) === toHex(selector('isValidSignature(bytes32,bytes)'))) {
        if (contract.isValidSignature === 'revert') return { data: null, revert: new Uint8Array(0), offchainLookup: null }
        const magic = contract.isValidSignature === 'accept' ? '1626ba7e' : 'ffffffff'
        return { data: fromHex('0x' + magic + '00'.repeat(28)), revert: null, offchainLookup: null }
      }
      return await (registry.chain.call as (...args: unknown[]) => Promise<unknown>)(tx, ...rest)
    }
  } as unknown as Chain
  return { chain, world, codes, queries, wallet, down }
}

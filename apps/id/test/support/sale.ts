// A username sale on the fork, step by step as the site will do it: fund a buyer, deploy the buyer's own resolver,
// commit, wait out the minimum age, register, then set the records. Fork tests only.

import { encode, encodeCall, toChecksumAddress } from '../../site/sdk/abi.js'
import { fromHex, toHex, utf8 } from '../../site/sdk/bytes.js'
import { type Chain, ChainError, type Receipt } from '../../site/sdk/chain.js'
import { dnsEncode } from '../../site/sdk/ens.js'
import { keccak256 } from '../../site/sdk/keccak.js'
import { ADDRESSES, nameOf, price, readContract } from '../../site/sdk/orivonid.js'
import { anvilRpc } from './anvil.ts'

/** Every role of a PermissionedResolver, set and admin, for one account. */
export const ALL_RESOLVER_ROLES = BigInt('0x' + '1'.repeat(64))

const DAI_BALANCE_SLOT = 2n

export async function daiBalance (chain: Chain, holder: string): Promise<bigint> {
  return (await readContract(chain, ADDRESSES.dai, 'balanceOf(address)', [holder], ['uint256']))[0] as bigint
}

/**
 * An address no one has ever used, derived from a name. Anvil's well-known accounts are not usable as buyers: some
 * carry an EIP-7702 delegation on mainnet, and a mint to one reverts when its code refuses the ERC-1155 receipt.
 */
export function freshAccount (name: string): string {
  return toChecksumAddress('0x' + toHex(keccak256(utf8(`orivon-id-test:${name}`)).slice(12)))
}

/** Lets the fork sign for the buyer, sets their DAI balance and gives them ether for gas. */
export async function fund (url: string, chain: Chain, buyer: string, dai: bigint): Promise<void> {
  await anvilRpc(url, 'anvil_impersonateAccount', [buyer])
  const slot = keccak256(encode(['address', 'uint256'], [buyer, DAI_BALANCE_SLOT]))
  await anvilRpc(url, 'anvil_setStorageAt', [ADDRESSES.dai, '0x' + toHex(slot), '0x' + dai.toString(16).padStart(64, '0')])
  await anvilRpc(url, 'anvil_setBalance', [buyer, '0x' + (10n ** 20n).toString(16)])
  if (await daiBalance(chain, buyer) !== dai) throw new Error('the DAI balance slot is not where the test assumes')
}

export async function mineSeconds (url: string, seconds: number): Promise<void> {
  await anvilRpc(url, 'evm_increaseTime', [seconds])
  await anvilRpc(url, 'evm_mine', [])
}

/** One transaction from `from`, mined, and required to have succeeded. */
export async function send (chain: Chain, from: string, to: string, signature: string, args: unknown[]): Promise<Receipt> {
  const hash = await chain.sendTransaction({ from, to, data: encodeCall(signature, args) })
  const receipt = await chain.waitForReceipt(hash, { intervalMs: 50 })
  if (receipt.status !== 1) throw new ChainError('reverted', `${signature} failed in block ${receipt.blockNumber}`)
  return receipt
}

export interface Sale { label: string, buyer: string, resolver: string, price: bigint, secret: Uint8Array, receipts: Receipt[] }

/** Steps 2 to 5 of the plan: the buyer's resolver, the approval, the commitment, the wait, the reveal. */
export async function buyName (url: string, chain: Chain, label: string, buyer: string, salt = 1n): Promise<Sale> {
  const cost = price(label)
  const secret = keccak256(utf8(`secret:${label}`))
  const [predicted] = await readContract(chain, ADDRESSES.verifiableFactory, 'predictProxyAddress(address,uint256)', [buyer, salt], ['address'])
  const resolver = predicted as string
  const receipts: Receipt[] = []
  receipts.push(await send(chain, buyer, ADDRESSES.dai, 'approve(address,uint256)', [ADDRESSES.registrar, cost]))
  const init = encodeCall('initialize((address,uint256)[],bytes[])', [[[buyer, ALL_RESOLVER_ROLES]], []])
  receipts.push(await send(chain, buyer, ADDRESSES.verifiableFactory, 'deployProxy(address,uint256,bytes)', [ADDRESSES.resolverImplementation, salt, init]))
  const commitment = keccak256(encode(['string', 'address', 'address', 'bytes32'], [label, buyer, resolver, secret]))
  receipts.push(await send(chain, buyer, ADDRESSES.registrar, 'commit(bytes32)', [commitment]))
  await mineSeconds(url, 61)
  receipts.push(await send(chain, buyer, ADDRESSES.registrar, 'register(string,address,address,bytes32)', [label, buyer, resolver, secret]))
  return { label, buyer, resolver, price: cost, secret, receipts }
}

/** Step 6: the address record, and any text records and contenthash. */
export async function setRecords (chain: Chain, sale: Sale, records: { texts?: Record<string, string>, contenthash?: Uint8Array }): Promise<void> {
  const name = dnsEncode(nameOf(sale.label))
  await send(chain, sale.buyer, sale.resolver, 'setAddress(bytes,uint256,bytes)', [name, 60n, fromHex(sale.buyer)])
  for (const [key, value] of Object.entries(records.texts ?? {})) await send(chain, sale.buyer, sale.resolver, 'setText(bytes,string,string)', [name, key, value])
  if (records.contenthash !== undefined) await send(chain, sale.buyer, sale.resolver, 'setContenthash(bytes,bytes)', [name, records.contenthash])
}

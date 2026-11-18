// A local anvil forked from Ethereum mainnet, and an Orivon ID bought on it step by step as the ID site buys one: fund a buyer, deploy the buyer's own
// resolver, commit, wait out the minimum age, register, then write the records. Test tooling only: every transaction is sent to the local fork by an
// account anvil lets sign, and the fork never forwards one; nothing here is ever sent to a public chain.

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, padHex, parseAbi, stringToBytes, toHex } from 'viem'
import { namehash, packetToBytes } from 'viem/ens'

/** Where the Orivon ID contracts are on mainnet (the ID site's own list). */
export const ADDRESSES = Object.freeze({
  dai: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  registrar: '0x27264C6AE4ec65fD14C0FB55C2Dc71eAa8956Cb4',
  verifiableFactory: '0x77510ba162dfeA3d8989E3f0928a691B345730D2',
  resolverImplementation: '0x565b0F456a04Ac9b48758190e90030623Cff57C5'
})
export const PARENT = 'v1.orivonid.eth'
/** Every role of a PermissionedResolver, set and admin, for one account. */
const ALL_RESOLVER_ROLES = BigInt(`0x${'1'.repeat(64)}`)
const DAI_BALANCE_SLOT = 2n
const NODES = ['https://ethereum-rpc.publicnode.com', 'https://rpc.mevblocker.io', 'https://rpc.flashbots.net']

const freePort = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = /** @type {import('node:net').AddressInfo} */ (server.address()); server.close(() => { resolve(port) }) }) })

/** One JSON-RPC call. @param {string} url @param {string} method @param {unknown[]} params @param {number} [ms] */
export async function rpc (url, method, params, ms = 20_000) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) })
  const body = /** @type {{ result?: any, error?: { message: string } }} */ (await response.json())
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

/** The first public node that serves the latest block and the registrar's code. @param {string[]} candidates */
async function nodeServing (candidates) {
  for (const url of candidates) {
    try {
      const code = await rpc(url, 'eth_getCode', [ADDRESSES.registrar, 'latest'], 15_000)
      if (typeof code === 'string' && code.startsWith('0x6080')) return url
    } catch { /* the next node */ }
  }
  return null
}

/**
 * A fork of mainnet's latest block, or the reason there is none.
 * @param {{ nodes?: string[] }} [options] public nodes to read from, `ORIVON_ID_FORK_RPC` first
 * @returns {Promise<{ url: string, nodeUrl: string, block: string, stop: () => Promise<void> } | { skip: string }>}
 */
export async function startFork ({ nodes = [...(process.env['ORIVON_ID_FORK_RPC'] === undefined ? [] : [process.env['ORIVON_ID_FORK_RPC']]), ...NODES] } = {}) {
  if (spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status !== 0) return { skip: 'anvil is not installed (Foundry)' }
  const nodeUrl = await nodeServing(nodes)
  if (nodeUrl === null) return { skip: 'no public Ethereum node answered: offline, or none serves the registrar' }
  const port = await /** @type {Promise<number>} */ (freePort())
  const url = `http://127.0.0.1:${String(port)}`
  // A block a few behind the head, so that a public node that is a block late still has it, and which anvil keeps on disk: a second run at the same block
  // (`ORIVON_ID_FORK_BLOCK`) asks the public node for almost nothing. The request rate is capped, because a public node that says "over rate limit"
  // mid-run makes anvil read a state that is not there.
  const block = process.env['ORIVON_ID_FORK_BLOCK'] ?? String(Number(await rpc(nodeUrl, 'eth_blockNumber', [])) - 6)
  const child = spawn('anvil', ['--fork-url', nodeUrl, '--fork-block-number', block, '--host', '127.0.0.1', '--port', String(port), '--compute-units-per-second', '60', '--retries', '8', '--timeout', '60000', '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let failure = ''
  child.stderr?.on('data', (chunk) => { failure += String(chunk) })
  let exited = false
  child.once('exit', () => { exited = true })
  const stop = async () => {
    if (exited) return
    child.kill('SIGTERM')
    await new Promise((resolve) => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(undefined) }, 3000); child.once('exit', () => { clearTimeout(timer); resolve(undefined) }) })
  }
  process.once('exit', () => { if (!exited) child.kill('SIGKILL') })
  for (let waited = 0; waited < 180_000 && !exited; waited += 250) {
    try { await rpc(url, 'eth_blockNumber', [], 2000); return { url, nodeUrl, block, stop } } catch { await new Promise((resolve) => setTimeout(resolve, 250)) }
  }
  await stop()
  return { skip: `anvil did not start: ${failure.trim().slice(0, 300) || 'no output'}` }
}

/** An address nobody has used, from a name (anvil's own accounts can carry an EIP-7702 delegation on mainnet, which refuses the ERC-1155 receipt of a sale). @param {string} name */
export const freshAccount = (name) => getAddress(`0x${keccak256(stringToBytes(`orivon-id-fixture:${name}`)).slice(26)}`)

/** One transaction from `from`, mined by the fork, which must have succeeded. @param {string} url @param {string} from @param {string} to @param {string} signature @param {unknown[]} args */
async function send (url, from, to, signature, args) {
  const abi = parseAbi([`function ${signature}`])
  const name = /** @type {string} */ (/** @type {any} */ (abi[0]).name)
  const data = encodeFunctionData({ abi, functionName: name, args })
  const hash = await rpc(url, 'eth_sendTransaction', [{ from, to, data }])
  let receipt = null
  for (let waited = 0; receipt === null && waited < 30_000; waited += 250) {
    receipt = await rpc(url, 'eth_getTransactionReceipt', [hash])
    if (receipt === null) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (receipt?.status !== '0x1') {
    const why = await rpc(url, 'eth_call', [{ from, to, data }, 'latest']).then(() => 'a call now succeeds', (error) => /** @type {Error} */ (error).message)
    throw new Error(`${name} ${receipt === null ? 'was not mined' : 'reverted'} on the fork (${why})`)
  }
  return receipt
}

/** A string as the `0x...` type viem's calls take. @param {string} value */
const hex = (value) => /** @type {`0x${string}`} */ (value)

/** The first word a view function answers. @param {string} url @param {string} to @param {string} signature @param {unknown[]} args @returns {Promise<string>} */
async function readWord (url, to, signature, args) {
  const abi = parseAbi([`function ${signature}`])
  const name = /** @type {string} */ (/** @type {any} */ (abi[0]).name)
  const answer = await rpc(url, 'eth_call', [{ to, data: encodeFunctionData({ abi, functionName: name, args }) }, 'latest'])
  return String(answer).slice(0, 66)
}

/** Lets the fork sign for `buyer`, gives them DAI (by the balance slot of mainnet's DAI) and ether for gas. @param {string} url @param {string} buyer @param {bigint} dai */
export async function fund (url, buyer, dai) {
  await rpc(url, 'anvil_impersonateAccount', [buyer])
  await rpc(url, 'anvil_setStorageAt', [ADDRESSES.dai, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [hex(buyer), DAI_BALANCE_SLOT])), padHex(toHex(dai), { size: 32 })])
  await rpc(url, 'anvil_setBalance', [buyer, toHex(10n ** 20n)])
  const held = BigInt(await readWord(url, ADDRESSES.dai, 'balanceOf(address) view returns (uint256)', [buyer]))
  if (held !== dai) throw new Error('the DAI balance slot is not where this run assumes')
}

/**
 * A username sold on the fork: `<label>.v1.orivonid.eth`, owned by `buyer` with a resolver of their own, whose records `setRecords` writes.
 * @param {string} url @param {string} label @param {string} buyer @param {number} [salt]
 */
export async function buyId (url, label, buyer, salt = 1) {
  const price = BigInt(await readWord(url, ADDRESSES.registrar, 'price(string) pure returns (uint256)', [label]))
  await fund(url, buyer, price)
  const resolver = getAddress(`0x${(await readWord(url, ADDRESSES.verifiableFactory, 'predictProxyAddress(address,uint256) view returns (address)', [hex(buyer), BigInt(salt)])).slice(26)}`)
  await send(url, buyer, ADDRESSES.dai, 'approve(address,uint256) returns (bool)', [ADDRESSES.registrar, price])
  const init = encodeFunctionData({ abi: parseAbi(['function initialize((address,uint256)[],bytes[])']), functionName: 'initialize', args: [[[hex(buyer), ALL_RESOLVER_ROLES]], []] })
  await send(url, buyer, ADDRESSES.verifiableFactory, 'deployProxy(address,uint256,bytes) returns (address)', [ADDRESSES.resolverImplementation, BigInt(salt), init])
  const secret = keccak256(stringToBytes(`secret:${label}`))
  const commitment = keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }], [label, hex(buyer), hex(resolver), secret]))
  await send(url, buyer, ADDRESSES.registrar, 'commit(bytes32)', [commitment])
  await rpc(url, 'evm_increaseTime', [61])
  await rpc(url, 'evm_mine', [])
  await send(url, buyer, ADDRESSES.registrar, 'register(string,address,address,bytes32)', [label, buyer, resolver, secret])
  const name = `${label}.${PARENT}`
  const dns = toHex(packetToBytes(name))
  /** Writes records on the buyer's resolver: the address, and each text. @param {Record<string, string>} texts */
  async function setRecords (texts) {
    await send(url, buyer, resolver, 'setAddress(bytes,uint256,bytes)', [dns, 60n, buyer])
    for (const [key, value] of Object.entries(texts)) await send(url, buyer, resolver, 'setText(bytes,string,string)', [dns, key, value])
  }
  return { name, label, buyer, resolver, price, setRecords, setText: (/** @type {string} */ key, /** @type {string} */ value) => send(url, buyer, resolver, 'setText(bytes,string,string)', [dns, key, value]) }
}

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'

/**
 * Texts written on the fork to a name that exists on mainnet and is not an Orivon ID: the fork signs for the name's owner, the registry names the name's
 * resolver, and the resolver takes the texts as it would from that owner. The name then resolves, with a record the run chose, as a name outside Orivon
 * does. (A name poked straight into the registry's storage does not resolve: the Universal Resolver reads `.eth` names through the .eth registrar.)
 * @param {string} url @param {string} name @param {Record<string, string>} texts
 */
export async function setTextsOfExistingName (url, name, texts) {
  const node = namehash(name)
  const owner = getAddress(`0x${(await readWord(url, ENS_REGISTRY, 'owner(bytes32) view returns (address)', [node])).slice(26)}`)
  const resolver = getAddress(`0x${(await readWord(url, ENS_REGISTRY, 'resolver(bytes32) view returns (address)', [node])).slice(26)}`)
  await rpc(url, 'anvil_impersonateAccount', [owner])
  await rpc(url, 'anvil_setBalance', [owner, toHex(10n ** 20n)])
  for (const [key, value] of Object.entries(texts)) await send(url, owner, resolver, 'setText(bytes32,string,string)', [node, key, value])
  return { name, owner, resolver }
}

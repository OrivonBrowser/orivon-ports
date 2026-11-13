// A stand-in for the page's `orivon` that holds the shape rules the real broker applies to ETH_NET_0_1 and ETH_0_1
// (transcribed from the two official modules): bytes are Uint8Array, quantities are hex strings without leading
// zeros, an optional field is absent rather than undefined, a log range is at most 1024 blocks. A call that breaks
// a rule rejects `invalid`, as the broker does, so an adapter that sends a wrong shape fails here.

export interface UseCall { codes: string[], groups: string[] | undefined }

type Handler = (...args: any[]) => unknown

const GROUPS: Record<string, Record<string, string>> = {
  ETH_NET_0_1_READONLY: {},
  ETH_NET_0_1: {
    sendRawTransaction: 'broadcast'
  },
  ETH_0_1: {
    getAddresses: 'addresses', chainId: 'addresses', signMessage: 'sign', signTypedData: 'sign', signTransaction: 'sign', signTransactions: 'plan'
  }
}
const READ_FUNCTIONS = [
  'chainId', 'blockNumber', 'getBalance', 'getTransactionCount', 'getCode', 'getStorageAt', 'call', 'estimateGas', 'gasPrice',
  'maxPriorityFeePerGas', 'getBlock', 'getTransaction', 'getTransactionReceipt', 'getLogs'
]

const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/
const BLOCK = /^(?:latest|safe|finalized|earliest|0x(?:0|[1-9a-f][0-9a-f]{0,15}))$/
const HASH = /^0x[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

function invalid (reason: string): never {
  throw Object.assign(new Error(reason), { code: 'invalid' })
}

const isBytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array
const isInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

function checkTransaction (value: unknown, allowed: string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('transaction: not an object')
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.includes(key)) invalid(`transaction.${key}: not a field`)
    if (field === undefined) invalid(`transaction.${key}: undefined`)
    if (key === 'from' || key === 'to') { if (typeof field !== 'string' || !ADDRESS.test(field)) invalid(`transaction.${key}: not an address`) } else if (key === 'data') { if (!isBytes(field)) invalid('transaction.data: not bytes') } else if (key === 'gas' || key === 'nonce' || key === 'chainId') { if (!isInteger(field)) invalid(`transaction.${key}: not an integer`) } else if (typeof field !== 'string' || !QUANTITY.test(field)) invalid(`transaction.${key}: not a quantity`)
  }
}

const CALL_FIELDS = ['from', 'to', 'gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'value', 'data', 'nonce']

function checkBlock (value: unknown, allowHash = false): void {
  if (value === undefined) return
  if (typeof value !== 'string' || !(BLOCK.test(value) || (allowHash && HASH.test(value)))) invalid(`block: ${String(value)}`)
}

const CHECKS: Record<string, (args: unknown[]) => void> = {
  chainId: (args) => { if (args.length !== 0) invalid('takes no arguments') },
  blockNumber: (args) => { if (args.length !== 0) invalid('takes no arguments') },
  gasPrice: (args) => { if (args.length !== 0) invalid('takes no arguments') },
  maxPriorityFeePerGas: (args) => { if (args.length !== 0) invalid('takes no arguments') },
  getAddresses: (args) => { if (args.length !== 0) invalid('takes no arguments') },
  getBlock: ([block]) => { checkBlock(block, true); if (block === undefined) invalid('block: missing') },
  getCode: ([address, block]) => { if (typeof address !== 'string' || !ADDRESS.test(address)) invalid('address'); checkBlock(block) },
  getTransactionCount: ([address, block]) => { if (typeof address !== 'string' || !ADDRESS.test(address)) invalid('address'); checkBlock(block) },
  call: ([tx, block, options]) => {
    checkTransaction(tx, CALL_FIELDS)
    checkBlock(block)
    if (options !== undefined && (typeof options !== 'object' || Object.keys(options as object).some((key) => key !== 'ccipRead'))) invalid('options')
  },
  estimateGas: ([tx, block]) => { checkTransaction(tx, CALL_FIELDS); checkBlock(block) },
  getTransactionReceipt: ([hash]) => { if (typeof hash !== 'string' || !HASH.test(hash)) invalid('hash') },
  getLogs: ([filter]) => {
    const fields = filter as Record<string, unknown>
    for (const [key, field] of Object.entries(fields)) {
      if (!['fromBlock', 'toBlock', 'address', 'topics'].includes(key) || field === undefined) invalid(`filter.${key}`)
    }
    for (const key of ['fromBlock', 'toBlock']) if (typeof fields[key] !== 'string' || !BLOCK.test(fields[key] as string)) invalid(`filter.${key}`)
    if (fields['address'] !== undefined && (!Array.isArray(fields['address']) || (fields['address'] as unknown[]).some((address) => typeof address !== 'string' || !ADDRESS.test(address)))) invalid('filter.address')
    if (fields['topics'] !== undefined && (!Array.isArray(fields['topics']) || (fields['topics'] as unknown[]).some((topic) => topic !== null && (typeof topic !== 'string' || !HASH.test(topic))))) invalid('filter.topics')
    const from = fields['fromBlock'] as string
    const to = fields['toBlock'] as string
    if (QUANTITY.test(from) && QUANTITY.test(to) && BigInt(to) - BigInt(from) + 1n > 1024n) throw Object.assign(new Error('the range is wider than 1024 blocks'), { code: 'limit' })
  },
  signMessage: ([message]) => { if (!isBytes(message)) invalid('message: not bytes') },
  signTransaction: ([tx]) => checkTransaction(tx, [...CALL_FIELDS, 'chainId']),
  signTransactions: ([list]) => {
    if (!Array.isArray(list) || list.length === 0 || list.length > 256) invalid('transactions: not a series')
    for (const tx of list as Record<string, unknown>[]) {
      checkTransaction(tx, ['to', 'data', 'value', 'gas', 'chainId'])
      if (tx['to'] === undefined || tx['gas'] === undefined || tx['chainId'] === undefined) invalid('transaction: to, gas and chainId are required')
      if ((tx['gas'] as number) < 21000) invalid('transaction.gas: below 21000')
    }
  },
  sendRawTransaction: ([bytes]) => { if (!isBytes(bytes) || bytes.length === 0) invalid('transaction: not bytes') }
}

export interface FakeOrivon {
  orivon: { use: (codes: string | string[], options?: { groups?: string[] }) => Promise<unknown> }
  uses: UseCall[]
  calls: { fn: string, args: unknown[] }[]
}

/**
 * `answers` maps a function name to what it returns (or a function of its arguments). `decline` lists the codes the
 * person refuses. Granted groups follow the `groups` option as `orivon.use` does. `plan: true` gives `ETH_0_1` the series signing call, which a
 * page's handle does not have today.
 */
export function fakeOrivon (answers: Record<string, unknown>, decline: string[] = [], options: { plan?: boolean } = {}): FakeOrivon {
  const uses: UseCall[] = []
  const calls: { fn: string, args: unknown[] }[] = []
  const handle = (code: string, groups: string[] | undefined) => {
    const out: Record<string, unknown> = { code }
    const names = code === 'ETH_NET_0_1_READONLY' ? READ_FUNCTIONS : [...Object.keys(GROUPS[code] ?? {}), ...(code === 'ETH_NET_0_1' ? READ_FUNCTIONS : [])]
    for (const fn of names) {
      // `plan` is browser-only: Orivon leaves the group out of a page's handle. A test of a wallet that does sign a series asks for it.
      if (fn === 'signTransactions' && options.plan !== true) continue
      const group = GROUPS[code]?.[fn] ?? 'read'
      if (groups !== undefined && !groups.includes(group)) continue
      const key = `${code}.${fn}`
      out[fn] = async (...args: unknown[]) => {
        CHECKS[fn]?.(args)
        calls.push({ fn: key, args })
        const answer = answers[key] ?? answers[fn]
        if (answer === undefined) throw Object.assign(new Error(`${key}: nothing scripted`), { code: 'unavailable' })
        if (typeof answer === 'function') return await (answer as Handler)(...args)
        return answer
      }
    }
    return Object.freeze(out)
  }
  return {
    uses,
    calls,
    orivon: {
      async use (codes, options) {
        const list = Array.isArray(codes) ? codes : [codes]
        uses.push({ codes: list, groups: options?.groups })
        const handles = list.map((code) => decline.includes(code) ? null : handle(code, options?.groups))
        return Object.freeze(handles)
      }
    }
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContext, lookupName } from '../site/fetchers.js'

// lookupName against made-up RPC replies: what each kind of answer becomes in a name's row.
const STATUS_ANSWER = '0x0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000f29100983e058b709f3d539b0c765937b804ac1500000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002ae50101720024080112202460095f41c03b13ffd464d02274359dff728eb8cf7124f53c58dd2f555a1a1d00000000000000000000000000000000000000000000'
const STATUS_KEY = 'k51qzi5uqu5dh386n6jw6dolvnxvxp5s1x9c0mhf8igbgvbahcnnxtkjz4qnml'

/** Every RPC answers with these JSON-RPC bodies, in turn; a number is an HTTP status with no body. */
function rpcReplies (...replies: (object | number)[]): string[] {
  const asked: string[] = []
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    asked.push(`${new URL(url).host} ${JSON.parse(init.body).params[0].to}`)
    const reply = replies.shift() ?? 503
    return typeof reply === 'number' ? new Response('', { status: reply }) : new Response(JSON.stringify(reply), { status: 200 })
  })
  return asked
}

afterEach(() => { vi.unstubAllGlobals() })

describe('lookupName', () => {
  it('asks the Universal Resolver and reads the contenthash it returns', async () => {
    const asked = rpcReplies({ jsonrpc: '2.0', id: 1, result: STATUS_ANSWER })
    expect(await lookupName(createContext(), 'status.orivonstack.eth')).toEqual({ status: 'found', contenthash: { kind: 'ipns', uri: `ipns://${STATUS_KEY}`, cid: STATUS_KEY } })
    expect(asked).toEqual(['ethereum-rpc.publicnode.com 0xeeeeeeee14d718c2b47d9923deab1335e144eeee'])
  })

  it('reads a revert by its data, after an RPC that refused', async () => {
    rpcReplies(429, { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: '0x77209fe8' + '00'.repeat(64) } })
    expect(await lookupName(createContext(), 'nobody.eth')).toEqual({ status: 'noresolver' })
    rpcReplies({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'execution reverted', data: '0x7b1c461b' + '00'.repeat(32) } })
    expect(await lookupName(createContext(), 'x.eth')).toEqual({ status: 'nocontenthash' })
    rpcReplies({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: '0x556f1830' + '00'.repeat(32) } })
    expect(await lookupName(createContext(), 'x.eth')).toMatchObject({ status: 'unreachable', detail: expect.stringContaining('offchain') })
    rpcReplies({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } })
    expect(await lookupName(createContext(), 'x.eth')).toEqual({ status: 'unreachable', detail: 'the Universal Resolver reverted with no reason' })
  })

  it('says why when no RPC answered, or the answer was malformed', async () => {
    rpcReplies(503, 503, 503)
    expect(await lookupName(createContext(), 'x.eth')).toEqual({ status: 'unreachable', detail: 'rpc.mevblocker.io 503' })
    rpcReplies({ jsonrpc: '2.0', id: 1, result: '0x' })
    expect(await lookupName(createContext(), 'x.eth')).toMatchObject({ status: 'unreachable', detail: expect.stringContaining('malformed') })
  })
})

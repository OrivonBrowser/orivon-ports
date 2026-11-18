// The services the anti-spam challenges call, as one local HTTP server for a test run: a chain's JSON-RPC with one fixture contract
// (an ERC-20 style `balanceOf`, which `evm-contract` reads), the spam-blocker and flags issuer endpoints that check a solved
// iframe session, and an OpenAI-style `responses` endpoint for `ai-moderation`. Test tooling only: nothing here is a transaction, and
// the real services are never called. `state` says what they answer next; `requests` is what they were asked, for the report.

import { createServer } from 'node:http'
import * as cborg from 'cborg'

export const BALANCE_OF = '0x70a08231'
/** The fixture contract's address; the balances are by wallet address, lowercase. */
export const CONTRACT = '0x00000000000000000000000000000000000000c7'

/** @param {import('node:http').IncomingMessage} request */
async function bodyOf (request) {
  const chunks = /** @type {Buffer[]} */ ([])
  for await (const chunk of request) chunks.push(/** @type {Buffer} */ (chunk))
  return Buffer.concat(chunks)
}

/** One JSON-RPC call. @param {Record<string, any>} call @param {Record<string, bigint>} balances */
function rpcAnswer (call, balances) {
  const reply = (/** @type {unknown} */ result) => ({ jsonrpc: '2.0', id: call['id'], result })
  const refuse = (/** @type {number} */ code, /** @type {string} */ message) => ({ jsonrpc: '2.0', id: call['id'], error: { code, message } })
  if (call['method'] === 'eth_chainId') return reply('0x1')
  if (call['method'] !== 'eth_call') return refuse(-32601, `${String(call['method'])} is not served`)
  const { to, data } = call['params'][0]
  // A call with no `to` is viem checking a signature through a contract it deploys on the fly; refused, it recovers the signer itself.
  if (to === undefined) return refuse(-32000, 'execution reverted')
  if (String(to).toLowerCase() !== CONTRACT || !String(data).startsWith(BALANCE_OF)) return refuse(-32000, 'execution reverted')
  const wallet = `0x${String(data).slice(BALANCE_OF.length + 24, BALANCE_OF.length + 64)}`.toLowerCase()
  return reply(`0x${(balances[wallet] ?? 0n).toString(16).padStart(64, '0')}`)
}

/** What the issuer's verify endpoint says of a session, by the test's `state`. @param {Record<string, any>} state @param {boolean} flag */
const verifyAnswer = (state, flag) => {
  if (!state['solved']) return { success: false, error: 'Challenge not completed.' }
  if (!flag) return { success: true, ipRisk: 0.1, ipAddressCountry: 'IT', ipTypeEstimation: 'residential' }
  return { success: true, flag: { type: 'country', code: 'IT', text: 'flag:country:it', issuer: 'flags.5chan.app', issuedAt: Math.floor(Date.now() / 1000), signature: { type: 'ed25519', signature: 'stand-in', publicKey: 'stand-in' } } }
}

/**
 * @param {{ balances: Record<string, bigint>, port?: number }} options the fixture contract's `balanceOf`, by lowercase wallet address; `port` is the loopback
 *   port to listen on (a run that must answer where an app's manifest grants a page, not the free one it is given by default)
 * @returns {Promise<{ url: string, state: { solved: boolean }, requests: Array<Record<string, any>>, close: () => Promise<void> }>}
 */
export async function startChallengeServices ({ balances, port: wanted = 0 }) {
  const state = { solved: true }
  const requests = /** @type {Array<Record<string, any>>} */ ([])
  const server = createServer((request, response) => {
    bodyOf(request).then((body) => {
      const path = String(request.url).split('?')[0]
      const json = (/** @type {unknown} */ value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
      if (path === '/chain') {
        const sent = JSON.parse(body.toString('utf8'))
        requests.push({ service: 'chain', methods: (Array.isArray(sent) ? sent : [sent]).map((call) => `${String(call.method)}${call.params?.[0]?.to === undefined ? '' : ':contract'}`) })
        json(Array.isArray(sent) ? sent.map((call) => rpcAnswer(call, balances)) : rpcAnswer(sent, balances))
      } else if (request.method === 'GET' && /^\/spam\/api\/v1\/iframe\/[^/]+\/lazy$/.test(path)) {
        // The page a poster is sent to when a board's spam-blocker holds a publication: the challenge package puts `<serverUrl>/iframe/<session>/lazy` in the challenge.
        const session = decodeURIComponent(path.split('/')[5] ?? '')
        requests.push({ service: 'spam', kind: 'iframe', session })
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Spam blocker stand-in</title></head><body style="font:16px sans-serif;padding:24px"><h1>Spam blocker stand-in</h1><p id="session">Session ${session.replace(/[^A-Za-z0-9-]/g, '')}</p><p>Solve this check, then press Finish Challenge on the page that opened it.</p></body></html>`)
      } else if (path === '/spam/api/v1/challenge/verify' || path === '/flags/api/v1/challenge/verify') {
        const sent = cborg.decode(body)
        const publicKey = sent.signature?.publicKey
        requests.push({ service: path.split('/')[1], path: path.slice(path.indexOf('/api')), session: typeof sent.sessionId === 'string', signedWith: publicKey instanceof Uint8Array ? `${publicKey.length}-byte key` : 'none' })
        json(verifyAnswer(state, path.startsWith('/flags')))
      } else if (path === '/ai/v1/responses') {
        const text = body.toString('utf8')
        requests.push({ service: 'ai', model: JSON.parse(text).model, bytes: text.length })
        json({ output_text: JSON.stringify(text.includes('FORBIDDEN') ? { verdict: 'review', reason: 'it holds a forbidden word' } : { verdict: 'allow' }) })
      } else json({ message: `${String(path)} is not served` }, 404)
    }).catch((error) => { response.writeHead(500); response.end(String(error)) })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(wanted, '127.0.0.1', () => { resolve(undefined) }) })
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  return { url: `http://127.0.0.1:${port}`, state, requests, close: () => new Promise((resolve) => { server.close(() => { resolve(undefined) }); server.closeAllConnections() }) }
}

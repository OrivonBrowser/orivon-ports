// An EIP-1193 provider that forwards to a JSON-RPC URL. The site never does this (it has no URL to ask); the tests
// use it to run the wallet-extension adapter against a real node.

export interface Eip1193Provider {
  request: (args: { method: string, params?: unknown[] }) => Promise<unknown>
}

export class RpcError extends Error {
  constructor (message: string, readonly code: number, readonly data?: unknown) {
    super(message)
  }
}

export function rpcProvider (url: string): Eip1193Provider {
  let id = 0
  return {
    async request ({ method, params = [] }) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })
      })
      const body = await response.json() as { result?: unknown, error?: { code: number, message: string, data?: unknown } }
      if (body.error !== undefined) throw new RpcError(body.error.message, body.error.code, body.error.data)
      return body.result
    }
  }
}

// The facade over the mock node, with a state file in a temporary directory and a `call` that issues a kubo command
// as the request kubo-rpc-client would send it.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKuboFacade, createNodeClient } from '../../kubo/index.js'
import { createMockNode, NODE_KEY } from './mock-node.ts'

export const API = 'http://127.0.0.1:5001'
export const GATEWAY = '/ip4/127.0.0.1/tcp/5001'

export interface CallOptions {
  args?: string[]
  query?: Record<string, string | number | boolean>
  body?: Uint8Array | string
  filename?: string
}

export async function createEnv (options: { statePath?: string, apiKey?: string, allowedOrigins?: string[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bitsocial-node-test-'))
  const node = createMockNode()
  const client = createNodeClient({ base: 'http://node.test', key: NODE_KEY, fetch: node.fetch })
  const statePath = options.statePath ?? join(dir, 'state.json')
  const facade = await createKuboFacade({ node: client, statePath, gateway: GATEWAY, ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }), ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }) })

  async function call (command: string, { args = [], query = {}, body, filename = '' }: CallOptions = {}): Promise<Response> {
    const url = new URL(`${API}/api/v0/${command}`)
    for (const arg of args) url.searchParams.append('arg', arg)
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value))
    const form = new FormData()
    if (body !== undefined) form.append('file', new Blob([body]), filename)
    return facade.handle(new Request(url, { method: 'POST', ...(body === undefined ? {} : { body: form }) }))
  }

  async function json<T = Record<string, unknown>> (command: string, callOptions?: CallOptions): Promise<T> {
    const response = await call(command, callOptions)
    if (!response.ok) throw new Error(`${command}: ${response.status} ${await response.text()}`)
    return await response.json() as T
  }

  return { dir, node, client, facade, statePath, call, json, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** The lines of an ndjson answer, parsed. */
export async function lines<T = Record<string, unknown>> (response: Response): Promise<T[]> {
  return (await response.text()).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as T)
}

export const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
export const textOf = (data: Uint8Array): string => new TextDecoder().decode(data)

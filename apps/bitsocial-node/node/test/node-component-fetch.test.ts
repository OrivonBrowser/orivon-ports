// Where the build gets the IPFS node component from: the files of the published folder, fetched by the pin's CID from
// the gateways in turn and each checked against its pin, or a local directory when `BITSOCIAL_IPFS_NODE_DIR` is set.
// The network is a stub that answers from a table: no test here reads a real gateway.
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addNodeComponent, GATEWAYS, NODE_COMPONENT, writePin } from '../../build/node-component.mjs'

const CID = 'bafybeiexamplefoldercid'
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The glue holds the line `writePin` packs, so a pin can be written from these files. */
const GLUE = "// the glue\nconst module0 = getCoreModule('ipfs-node.core.wasm');\n"
/** A component of three files, one of them at the folder's root as the two licences are, with each file's path in the folder. */
const BODIES: Record<string, { path: string, under: string, text: string }> = {
  'ipfs-node.js': { path: 'ipfs-node.p2/ipfs-node.js', under: 'bin/ipfs-node.p2', text: GLUE },
  'ipfs-node.core2.wasm': { path: 'ipfs-node.p2/ipfs-node.core2.wasm', under: 'bin/ipfs-node.p2', text: 'a part of the program' },
  'LICENSE-MIT': { path: 'LICENSE-MIT', under: 'bin', text: 'the licence' }
}
const files = Object.entries(BODIES).map(([name, body]) => ({ name, bytes: Buffer.byteLength(body.text), sha256: sha(body.text), under: body.under }))
const [GATEWAY_A, GATEWAY_B, GATEWAY_C] = GATEWAYS as [string, string, string]

type Answer = Response | Error | undefined
/** A `fetch` that answers each URL from `answers` (a missing URL is a 404) and records every URL it was asked. */
function network (answers: Record<string, Answer>): { fetch: typeof globalThis.fetch, asked: string[] } {
  const asked: string[] = []
  const answer = async (input: Parameters<typeof globalThis.fetch>[0]): Promise<Response> => {
    const url = String(input)
    asked.push(url)
    const given = answers[url]
    if (given instanceof Error) throw given
    return given?.clone() ?? new Response('not found', { status: 404 })
  }
  return { fetch: answer as typeof globalThis.fetch, asked }
}
const served = (gateway: string, name: string, text?: string): Record<string, Answer> => ({ [`${gateway}/ipfs/${CID}/${(BODIES[name] as { path: string }).path}`]: new Response(text ?? (BODIES[name] as { text: string }).text) })
const everyFile = (gateway: string): Record<string, Answer> => Object.assign({}, ...Object.keys(BODIES).map((name) => served(gateway, name)))

describe('fetching the node component by its CID', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bitsocial-component-fetch-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  const read = (name: string): Promise<string> => readFile(join(dir, 'out', (BODIES[name] as { under: string }).under, name), 'utf8')

  it('is the published folder: the pin names a CID, and the gateways are the three public ones', () => {
    expect(NODE_COMPONENT.cid).toMatch(/^bafy[a-z2-7]{50,}$/)
    expect(GATEWAYS).toEqual(['https://ipfs.orbitor.dev', 'https://ipfs.filebase.io', 'https://trustless-gateway.link'])
  })

  it('asks the first gateway for each file by its path in the folder, and writes what it sends', async () => {
    const { fetch, asked } = network(everyFile(GATEWAY_A))
    await addNodeComponent(join(dir, 'out'), {}, { files, packed: [], cid: CID, fetch })
    for (const [name, body] of Object.entries(BODIES)) expect(await read(name)).toBe(body.text)
    expect(asked).toEqual([
      `${GATEWAY_A}/ipfs/${CID}/ipfs-node.p2/ipfs-node.js`,
      `${GATEWAY_A}/ipfs/${CID}/ipfs-node.p2/ipfs-node.core2.wasm`,
      `${GATEWAY_A}/ipfs/${CID}/LICENSE-MIT`
    ])
  })

  it('goes to the next gateway when one sends bytes that are not the pinned ones', async () => {
    const { fetch, asked } = network({
      ...everyFile(GATEWAY_B),
      ...served(GATEWAY_A, 'ipfs-node.js'),
      ...served(GATEWAY_A, 'ipfs-node.core2.wasm', 'a gateway that rewrites what it serves'),
      ...served(GATEWAY_A, 'LICENSE-MIT')
    })
    await addNodeComponent(join(dir, 'out'), {}, { files, packed: [], cid: CID, fetch })
    expect(await read('ipfs-node.core2.wasm')).toBe('a part of the program')
    expect(asked).toContain(`${GATEWAY_B}/ipfs/${CID}/ipfs-node.p2/ipfs-node.core2.wasm`)
    expect(asked).not.toContain(`${GATEWAY_B}/ipfs/${CID}/LICENSE-MIT`)
  })

  it('goes to the next gateway when one answers an error or cannot be reached, for each file in turn', async () => {
    const { fetch, asked } = network({
      ...everyFile(GATEWAY_A),
      [`${GATEWAY_A}/ipfs/${CID}/ipfs-node.p2/ipfs-node.js`]: new Response('busy', { status: 503 }),
      [`${GATEWAY_B}/ipfs/${CID}/ipfs-node.p2/ipfs-node.js`]: new Error('fetch failed'),
      ...served(GATEWAY_C, 'ipfs-node.js')
    })
    await addNodeComponent(join(dir, 'out'), {}, { files, packed: [], cid: CID, fetch })
    expect(await read('ipfs-node.js')).toBe(GLUE)
    expect(asked.slice(0, 3)).toEqual([GATEWAY_A, GATEWAY_B, GATEWAY_C].map((gateway) => `${gateway}/ipfs/${CID}/ipfs-node.p2/ipfs-node.js`))
    expect(asked[3]).toBe(`${GATEWAY_A}/ipfs/${CID}/ipfs-node.p2/ipfs-node.core2.wasm`)
  })

  it('stops when no gateway sends the pinned file, naming the CID, the file, what each gateway did and the way out', async () => {
    const { fetch } = network({
      ...served(GATEWAY_A, 'ipfs-node.js', 'not the glue'),
      [`${GATEWAY_B}/ipfs/${CID}/ipfs-node.p2/ipfs-node.js`]: new Response('busy', { status: 503 })
    })
    const failure = await addNodeComponent(join(dir, 'out'), {}, { files, packed: [], cid: CID, fetch }).catch((error: unknown) => error as Error)
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain(CID)
    expect(message).toContain('ipfs-node.p2/ipfs-node.js')
    expect(message).toMatch(new RegExp(`${GATEWAY_A.replaceAll('.', '\\.')}: sent other bytes than the pinned ipfs-node\\.js`))
    expect(message).toContain(`${GATEWAY_B}: answered 503`)
    expect(message).toContain(`${GATEWAY_C}: answered 404`)
    expect(message).toContain('BITSOCIAL_IPFS_NODE_DIR')
  })

  it('names the cause of a network failure', async () => {
    const reset = new Error('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
    const { fetch } = network({ [`${GATEWAY_A}/ipfs/${CID}/ipfs-node.p2/ipfs-node.js`]: reset })
    await expect(addNodeComponent(join(dir, 'out'), {}, { files, packed: [], cid: CID, fetch })).rejects.toThrow(`${GATEWAY_A}: fetch failed (ECONNREFUSED)`)
  })

  it('reads a local directory in place of the network when BITSOCIAL_IPFS_NODE_DIR is set, and asks no gateway', async () => {
    const from = join(dir, 'from')
    await mkdir(join(from, 'ipfs-node.p2'), { recursive: true })
    for (const [name, body] of Object.entries(BODIES)) await writeFile(join(from, body.path), body.text)
    const { fetch, asked } = network(everyFile(GATEWAY_A))
    await addNodeComponent(join(dir, 'out'), { BITSOCIAL_IPFS_NODE_DIR: from }, { files, packed: [], cid: CID, fetch })
    expect(await read('ipfs-node.js')).toBe(GLUE)
    expect(asked).toEqual([])
  })

  it('checks a local directory against the pin as it checks a gateway', async () => {
    const from = join(dir, 'from')
    await mkdir(from)
    for (const name of Object.keys(BODIES)) await writeFile(join(from, name), 'another build')
    const { fetch } = network(everyFile(GATEWAY_A))
    await expect(addNodeComponent(join(dir, 'out'), { BITSOCIAL_IPFS_NODE_DIR: from }, { files, packed: [], cid: CID, fetch })).rejects.toThrow(/is not the pinned ipfs-node\.js/)
  })

  it('needs the directory when the pin names no CID, and says so before it asks a gateway', async () => {
    const { fetch, asked } = network(everyFile(GATEWAY_A))
    await expect(addNodeComponent(join(dir, 'out'), {}, { files, packed: [], cid: null, fetch })).rejects.toThrow(/names no CID.*BITSOCIAL_IPFS_NODE_DIR/)
    await expect(addNodeComponent(join(dir, 'out'), { BITSOCIAL_IPFS_NODE_DIR: '' }, { files, packed: [], cid: null, fetch })).rejects.toThrow(/names no CID/)
    expect(asked).toEqual([])
  })

  it('writePin records the CID it is given, and none when it is given none', async () => {
    const from = join(dir, 'from')
    await mkdir(from)
    for (const name of Object.keys(BODIES)) await writeFile(join(from, name), (BODIES[name] as { text: string }).text)
    const pinned = async (cid: string | null): Promise<{ cid: string | null, files: unknown[] }> => {
      const target = join(dir, `pin-${String(cid)}.mjs`)
      await writePin(from, ['--flag'], ['feature'], { target, files, ...(cid === null ? {} : { cid }) })
      return (await import(`${target}?${String(Date.now())}`)).default as { cid: string | null, files: unknown[] }
    }
    expect((await pinned(CID)).cid).toBe(CID)
    const without = await pinned(null)
    expect(without.cid).toBeNull()
    expect(without.files).toEqual(files)
  })
})

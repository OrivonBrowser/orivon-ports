import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cidFor, DAG_PB } from '../page/src/ipfs/cid.js'
import { encodeNode, encodeUnixfs, UNIXFS_DIRECTORY } from '../page/src/ipfs/dagpb.js'
import { importDirectory, importFile } from '../page/src/ipfs/unixfs.js'
import { readWiki, waitForPeer, whilePeered } from '../relay/from-node.mjs'
import { CORE_CIDS, KNOWN_CORES, Refusal, checkFiles } from '../relay/rules.mjs'

const encoder = new TextEncoder()
const CORE_NAME = 'tiddlywikicore-5.4.1.js'
const PAGE = `\n\n<!doctype html><html><body><script class="tiddlywiki-tiddler-store" type="application/json">[{"title":"$:/plugins/orivon/decentrawiki","text":"{}"}]</script><script src="${CORE_NAME}" onerror="x"></script></body></html>`
const coreBytes = encoder.encode('/* a TiddlyWiki core, for the test */')
const real = { sha: KNOWN_CORES[CORE_NAME], cid: CORE_CIDS[CORE_NAME] }

beforeEach(async () => {
  (KNOWN_CORES as Record<string, string>)[CORE_NAME] = createHash('sha256').update(coreBytes).digest('hex');
  (CORE_CIDS as Record<string, string>)[CORE_NAME] = (await importFile(coreBytes)).cid
})
afterEach(() => {
  (KNOWN_CORES as Record<string, string>)[CORE_NAME] = real.sha;
  (CORE_CIDS as Record<string, string>)[CORE_NAME] = real.cid
})

/** A Kubo that holds `files` as `ipfs add -r` would, and records every call it gets. */
async function fakeKubo (files: Record<string, Uint8Array | string>, extraBlocks: Map<string, Uint8Array> = new Map()) {
  const list = Object.entries(files).map(([path, bytes]) => ({ path, bytes: typeof bytes === 'string' ? encoder.encode(bytes) : bytes }))
  const { cid, blocks } = await importDirectory(list)
  const byCid = new Map<string, Uint8Array>()
  for (const file of list) byCid.set((await importFile(file.bytes)).cid, file.bytes)
  for (const [k, v] of extraBlocks) blocks.set(k, v)
  const calls: string[] = []
  const kubo = async (path: string, { maxBytes }: { timeoutMs: number, maxBytes: number }) => {
    calls.push(path)
    const [verb, query] = path.split('?')
    const arg = new URLSearchParams(query).get('arg') ?? ''
    const found = verb === 'block/get' ? blocks.get(arg) : verb === 'cat' ? byCid.get(arg) : undefined
    if (found === undefined) throw new Error(`not found ${path}`)
    if (found.length > maxBytes) throw new Refusal(413, 'too large')
    return found
  }
  return { cid, kubo, calls }
}

async function refusal (promise: Promise<unknown>): Promise<Refusal> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Refusal) return error
    throw error
  }
  throw new Error('accepted what should be refused')
}

describe('reading a wiki from the page\'s node', () => {
  it('reads the folder, its page and its core, and they pass the upload checks', async () => {
    const { cid, kubo } = await fakeKubo({ 'index.html': PAGE, [CORE_NAME]: coreBytes })
    const files = await readWiki(kubo, cid)
    expect([...files.keys()].sort()).toEqual(['index.html', CORE_NAME])
    const checked = await checkFiles(files)
    expect((await importDirectory(checked)).cid).toBe(cid)
  })

  it('refuses a folder with another file before fetching anything but the folder', async () => {
    const { cid, kubo, calls } = await fakeKubo({ 'index.html': PAGE, [CORE_NAME]: coreBytes, 'movie.mp4': 'x' })
    expect((await refusal(readWiki(kubo, cid))).message).toMatch(/movie\.mp4 is not part/)
    expect(calls).toEqual([`block/get?arg=${cid}`])
  })

  it('refuses a core that is not the known one, without fetching it', async () => {
    const { cid, kubo, calls } = await fakeKubo({ 'index.html': PAGE, [CORE_NAME]: 'evil()' })
    expect((await refusal(readWiki(kubo, cid))).message).toMatch(/not the TiddlyWiki core it names/)
    expect(calls).toHaveLength(1)
  })

  it('refuses a page whose link declares more than the limit, before fetching it', async () => {
    const { cid: pageCid } = await importFile(encoder.encode(PAGE))
    const coreCid = CORE_CIDS[CORE_NAME]
    const { parseCid } = await import('../page/src/ipfs/cid.js')
    const root = encodeNode([
      { hash: parseCid(pageCid).bytes, name: 'index.html', tsize: 50 * 1024 * 1024 },
      { hash: parseCid(coreCid).bytes, name: CORE_NAME, tsize: coreBytes.length }
    ], encodeUnixfs({ type: UNIXFS_DIRECTORY, blocksizes: [] }))
    const rootCid = (await cidFor(DAG_PB, root)).string
    const { kubo, calls } = await fakeKubo({ 'index.html': PAGE, [CORE_NAME]: coreBytes }, new Map([[rootCid, root]]))
    expect((await refusal(readWiki(kubo, rootCid))).status).toBe(413)
    expect(calls).toEqual([`block/get?arg=${rootCid}`])
  })

  it('refuses a root block whose bytes are not its CID\'s, a raw CID, and a file as the root', async () => {
    const { cid, kubo } = await fakeKubo({ 'index.html': PAGE, [CORE_NAME]: coreBytes })
    const lying = async (path: string, options: { timeoutMs: number, maxBytes: number }) => path.startsWith('block/get') ? encoder.encode('not it') : kubo(path, options)
    expect((await refusal(readWiki(lying, cid))).message).toMatch(/something other than this wiki/)
    const { cid: fileCid } = await importFile(encoder.encode('a small file'))
    expect((await refusal(readWiki(kubo, fileCid))).message).toMatch(/one folder/)
  })

  it('says the page is unreachable when the node does not answer in time', async () => {
    const silent = async () => { throw new Error('timeout') }
    const { cid } = await fakeKubo({ 'index.html': PAGE, [CORE_NAME]: coreBytes })
    expect((await refusal(readWiki(silent, cid))).status).toBe(504)
  })

  it('waits for the page\'s node among the Kubo node\'s peers, and says so when it never comes', async () => {
    const peer = '12D3KooWBFpVc6cRWcWt72deRUy5SG2Ezcb4w3XqJF9pxp9WE7ne'
    const listing = (peers: string[]) => async () => encoder.encode(JSON.stringify({ Peers: peers.map((p) => ({ Peer: p, Addr: '/ip4/198.51.100.7/tcp/50520' })) }))
    expect(await waitForPeer(listing([peer]), peer, 0)).toBe(`/ip4/198.51.100.7/tcp/50520/p2p/${peer}`)
    expect((await refusal(waitForPeer(listing([]), peer, 0))).status).toBe(409)
  })

  it('peers with the page\'s node only while it reads, and stops even when the read fails', async () => {
    const calls: string[] = []
    const kubo = async (path: string) => { calls.push(path); return new Uint8Array(0) }
    const addr = '/ip4/198.51.100.7/tcp/50520/p2p/12D3KooWPage'
    expect(await whilePeered(kubo, '12D3KooWPage', addr, async () => 'read')).toBe('read')
    await expect(whilePeered(kubo, '12D3KooWPage', addr, async () => { throw new Refusal(504, 'no') })).rejects.toThrow('no')
    expect(calls).toEqual([
      `swarm/peering/add?arg=${encodeURIComponent(addr)}`, 'swarm/peering/rm?arg=12D3KooWPage',
      `swarm/peering/add?arg=${encodeURIComponent(addr)}`, 'swarm/peering/rm?arg=12D3KooWPage'
    ])
  })
})

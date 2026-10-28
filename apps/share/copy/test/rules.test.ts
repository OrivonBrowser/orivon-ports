import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readCar, writeCar } from '../../page/src/ipfs/car.js'
import { RAW, cidFor, concatBytes } from '../../page/src/ipfs/cid.js'
import { importTree } from '../../page/src/ipfs/unixfs.js'
import { LIMITS, Refusal, TOO_LARGE, checkCar } from '../rules.mjs'

/** A share as the page keeps it: the blocks of a directory built the way Kubo's `add -r --cid-version=1` builds it. */
async function shareOf (files: Record<string, string | Uint8Array>) {
  const blocks = new Map<string, Uint8Array>()
  const tree = Object.entries(files).map(([path, content]) => ({ path, content: new Blob([content]) }))
  const { cid } = await importTree(tree, async (blockCid: string, bytes: Uint8Array) => { blocks.set(blockCid, bytes) })
  return { cid, blocks, car: writeCar(cid, blocks) }
}

/** A share of fresh random bytes, so that no two tests (or runs) make the same address. */
const randomShare = async (size = 700_000) => await shareOf({ 'note.txt': randomBytes(16).toString('hex'), 'data.bin': randomBytes(size) })

const rawBlock = async (bytes: Uint8Array) => (await cidFor(RAW, bytes)).string

/** Runs the check on `car` the way the service does, and returns what it wrote. */
async function check (car: Uint8Array, root: string, maxBytes?: number) {
  const written: Uint8Array[] = []
  const result = await checkCar(new Blob([car]).stream(), root, async (chunk) => { written.push(chunk) }, maxBytes)
  return { ...result, car: concatBytes(written) }
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

describe('what the copy service accepts', () => {
  it('takes a share and writes a CAR of the checked blocks, which holds exactly the share', async () => {
    const share = await randomShare()
    const checked = await check(share.car, share.cid)
    expect(checked.blocks).toBe(share.blocks.size)
    expect(checked.bytes).toBe(checked.car.length)
    const again = await readCar(checked.car, share.cid)
    expect([...again.keys()].sort()).toEqual([...share.blocks.keys()].sort())
  })

  it('takes a folder of many small files, and a block sent twice once', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 40; i++) files[`d${i % 4}/f${i}.txt`] = `file ${i}`
    const share = await shareOf(files)
    const doubled = writeCar(share.cid, new Map([...share.blocks]))
    const [first] = share.blocks
    const twice = concatBytes([doubled, writeCar(share.cid, new Map([first as [string, Uint8Array]])).subarray(writeCar(share.cid, new Map()).length)])
    expect((await check(twice, share.cid)).blocks).toBe(share.blocks.size)
  })

  it('refuses a block whose bytes are not its address, and a CAR cut short', async () => {
    const share = await randomShare()
    const tampered = share.car.slice()
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff
    expect((await refusal(check(tampered, share.cid))).message).toMatch(/does not match its address/)
    expect((await refusal(check(share.car.subarray(0, share.car.length - 5), share.cid))).status).toBe(400)
  })

  it('refuses a CAR that is for another address than the one it is sent under', async () => {
    const [one, other] = [await randomShare(), await randomShare()]
    const refused = await refusal(check(one.car, other.cid))
    expect(refused.status).toBe(400)
    expect(refused.message).toMatch(/not a share Orivon's server can keep/)
  })

  it('refuses a block that is not part of the share, and a share with a block missing', async () => {
    const share = await randomShare()
    const extra = new Uint8Array([1, 2, 3, 4])
    const withExtra = new Map(share.blocks).set(await rawBlock(extra), extra)
    expect((await refusal(check(writeCar(share.cid, withExtra), share.cid))).message).toMatch(/not part of the share/)
    const leaf = [...share.blocks].find(([cid, bytes]) => cid !== share.cid && bytes.length > 200_000)![0]
    const without = new Map(share.blocks)
    without.delete(leaf)
    expect((await refusal(check(writeCar(share.cid, without), share.cid))).message).toMatch(/incomplete/)
    const rootless = new Map(share.blocks)
    rootless.delete(share.cid)
    expect((await refusal(check(writeCar(share.cid, rootless), share.cid))).message).toMatch(/first block/)
  })

  it('refuses a block that is neither a file nor a folder', async () => {
    const share = await randomShare()
    const dagCbor = Uint8Array.of(0xa0)
    const block = (await cidFor(0x71, dagCbor)).string
    expect((await refusal(check(writeCar(share.cid, new Map(share.blocks).set(block, dagCbor)), share.cid))).message).toMatch(/another kind of block/)
  })

  it('refuses a CAR larger than it may be, with the words the page shows', async () => {
    const share = await randomShare()
    const refused = await refusal(check(share.car, share.cid, 100_000))
    expect(refused.status).toBe(413)
    expect(refused.message).toBe(TOO_LARGE)
    expect(LIMITS.carBytes).toBe(200 * 1024 * 1024)
  })
})

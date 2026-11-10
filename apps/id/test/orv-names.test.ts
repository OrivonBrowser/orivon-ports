import { describe, expect, it } from 'vitest'
import { decode, toChecksumAddress } from '../site/sdk/abi.js'
import { ChainError } from '../site/sdk/chain.js'
import { dnsEncode } from '../site/sdk/ens.js'
import { ADDRESSES } from '../site/sdk/orivonid.js'
import { ensNameOf, MAX_LABELS, parseOrvName, resolveOrv } from '../site/resolver/orv-names.js'
import { fakeOrv, type OrvWorld } from './support/fake-orv.ts'

const address = (n: number) => toChecksumAddress('0x' + n.toString(16).padStart(40, '0'))
const ALICE = address(0xa11ce)
const BOB = address(0xb0b)
const RES_A = address(0x7e51)
const RES_D = address(0x7e52)
const SUB_A = address(0x5b01)
const SUB_D = address(0x5b02)
const UNIVERSAL_RESOLVERS = ['0x06Fdd07F007ADaC667177b46aB2EB9A75132Cfd5', '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe']

const IPFS_HASH = '0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f'
const IPFS_ADDRESS = 'ipfs://bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4'
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const BUNDLE = 'sha256:' + 'ab'.repeat(32)
const TEXTS = {
  'content.ipfs': `ipfs://${CID}`, 'content.https': 'https://example.com/app', 'content.ddoc': BUNDLE,
  'content.magnet': 'magnet:?xt=urn:btih:' + '1'.repeat(40), 'url': 'https://example.com/', 'avatar': 'https://example.com/me.png'
}
const FULL_ANSWER = {
  ownerDefault: { type: 'ipfs', value: IPFS_ADDRESS },
  records: [
    { type: 'ipfs', value: `ipfs://${CID}` }, { type: 'magnet', value: 'magnet:?xt=urn:btih:' + '1'.repeat(40) },
    { type: 'https', value: 'https://example.com/app' }, { type: 'ddoc', value: BUNDLE }
  ]
}

const world = (extra: Partial<OrvWorld> = {}): OrvWorld => ({
  names: { alice: { owner: ALICE, resolver: RES_A } },
  resolvers: { [RES_A]: { addr: ALICE, contenthash: IPFS_HASH, texts: TEXTS } },
  registrar: {},
  ...extra
})

describe('parseOrvName', () => {
  it('reads the sold label first and the labels below it after', () => {
    expect(parseOrvName('alice.orv')).toEqual(['alice'])
    expect(parseOrvName('docs.alice.orv')).toEqual(['alice', 'docs'])
    expect(parseOrvName('b.a-1.alice.orv')).toEqual(['alice', 'a-1', 'b'])
  })

  it('ignores case and one trailing dot', () => {
    expect(parseOrvName('ALICE.Orv.')).toEqual(['alice'])
    expect(parseOrvName('Docs.ALICE.ORV')).toEqual(['alice', 'docs'])
  })

  it('finds no name for a sold label the registrar would refuse, and never builds one from it', () => {
    for (const name of ['ab.orv', '.orv', 'orv', 'a..orv', '-abc.orv', 'abc-.orv', 'ab--cd.orv', 'xn--abc.orv', 'a_b.orv', 'a'.repeat(64) + '.orv', '0x' + 'a'.repeat(40) + '.orv']) {
      expect(parseOrvName(name), name).toBeNull()
    }
  })

  it('finds no name for a label outside ASCII, which lower-casing could fold into an ASCII one', () => {
    const kelvin = String.fromCodePoint(0x212a)
    const zeroWidth = String.fromCodePoint(0x200b)
    for (const name of ['caf' + String.fromCodePoint(0xe9) + '.orv', `${kelvin}elvin.orv`, `al${zeroWidth}ice.orv`, `alice.orv${zeroWidth}`, ' alice.orv', 'alice .orv', 'alice.orv\n']) {
      expect(parseOrvName(name), JSON.stringify(name)).toBeNull()
    }
  })

  it('finds no name for a label below the sold one that is not a lower-case DNS label', () => {
    for (const name of ['-x.alice.orv', 'x-.alice.orv', 'ab--c.alice.orv', 'x_y.alice.orv', 'a'.repeat(64) + '.alice.orv', '..alice.orv']) {
      expect(parseOrvName(name), name).toBeNull()
    }
  })

  it('allows the labels below the sold one that DNS allows, one letter included', () => {
    expect(parseOrvName('a.alice.orv')).toEqual(['alice', 'a'])
    expect(parseOrvName('a'.repeat(63) + '.alice.orv')).toEqual(['alice', 'a'.repeat(63)])
  })

  it('stops at the most labels, and at a name too long for a DNS name once it is under v1.orivonid.eth', () => {
    const deep = (count: number) => [...Array.from({ length: count - 1 }, (_, i) => `l${i}`), 'alice', 'orv'].join('.')
    expect(parseOrvName(deep(MAX_LABELS))).toHaveLength(MAX_LABELS)
    expect(parseOrvName(deep(MAX_LABELS + 1))).toBeNull()
    const long = ['b'.repeat(63), 'b'.repeat(63), 'b'.repeat(63), 'b'.repeat(49), 'alice', 'orv'].join('.')
    expect(long.length).toBeLessThanOrEqual(253)
    expect(parseOrvName(long)).toBeNull()
  })

  it('refuses a name that is not under .orv, so the router goes on to the next provider', () => {
    for (const name of ['alice.eth', 'alice.v1.orivonid.eth', 'orv.com', 'alice.orvx']) {
      expect(() => parseOrvName(name), name).toThrow(expect.objectContaining({ code: 'invalid' }))
    }
    expect(() => parseOrvName(undefined)).toThrow(expect.objectContaining({ code: 'invalid' }))
  })

  it('names the ENS name under v1.orivonid.eth', () => {
    expect(ensNameOf(['alice'])).toBe('alice.v1.orivonid.eth')
    expect(ensNameOf(['alice', 'a', 'b'])).toBe('b.a.alice.v1.orivonid.eth')
  })
})

describe('resolveOrv on the registry', () => {
  it('answers the contenthash as the default and the content records after it, as Orivon\'s ENS does', async () => {
    const { chain } = fakeOrv(world())
    const answer = await resolveOrv(chain, 'alice.orv')
    expect(answer).toEqual({ ...FULL_ANSWER, provenance: { by: 'Orivon ID', proven: false, block: 26357300 } })
  })

  it('answers the same for the name in any case and with a trailing dot', async () => {
    const { chain } = fakeOrv(world())
    const first = await resolveOrv(chain, 'alice.orv')
    expect(await resolveOrv(chain, 'ALICE.ORV')).toEqual(first)
    expect(await resolveOrv(chain, 'Alice.orv.')).toEqual(first)
  })

  it('reads R1 and the name\'s resolver only, all at one block, never a Universal Resolver', async () => {
    const { chain, calls } = fakeOrv(world())
    await resolveOrv(chain, 'alice.orv')
    const asked = new Set(calls.map((call) => call.to.toLowerCase()))
    expect([...asked].sort()).toEqual([ADDRESSES.r1.toLowerCase(), RES_A.toLowerCase()].sort())
    for (const universal of UNIVERSAL_RESOLVERS) expect(asked.has(universal.toLowerCase())).toBe(false)
    expect(new Set(calls.map((call) => call.block))).toEqual(new Set([26357300]))
  })

  it('asks the resolver for the name under v1.orivonid.eth, never for the .orv name', async () => {
    const { chain, calls } = fakeOrv(world())
    await resolveOrv(chain, 'alice.orv')
    const asked = calls.filter((call) => call.to === RES_A && call.data.length > 4 && call.selector !== '01ffc9a7')
    expect(asked).toHaveLength(1)
    const [name] = decode(['bytes', 'bytes'], asked[0]!.data.subarray(4)) as [Uint8Array]
    expect(name).toEqual(dnsEncode('alice.v1.orivonid.eth'))
  })

  it('reads the records in one multicall when the resolver takes it, and one by one when it does not, with the same answer', async () => {
    const together = fakeOrv(world())
    const alone = fakeOrv(world({ multicall: false }))
    const [one, other] = [await resolveOrv(together.chain, 'alice.orv'), await resolveOrv(alone.chain, 'alice.orv')]
    expect(other).toEqual(one)
    const records = (calls: { to: string, selector: string }[]) => calls.filter((call) => call.to === RES_A && call.selector !== '01ffc9a7').length
    expect(records(together.calls)).toBe(1)
    expect(records(alone.calls)).toBe(1 + 1 + 7)
  })

  it('reads a resolver that is not ENSIP-10 with plain profile calls', async () => {
    const { chain, calls } = fakeOrv(world({ resolvers: { [RES_A]: { extended: false, contenthash: IPFS_HASH, texts: TEXTS } } }))
    expect(await resolveOrv(chain, 'alice.orv')).toMatchObject(FULL_ANSWER)
    expect(calls.some((call) => call.to === RES_A && call.selector === '9061b923')).toBe(false)
  })

  it('finds no records for a name whose resolver holds none', async () => {
    const { chain } = fakeOrv(world({ resolvers: { [RES_A]: { addr: ALICE } } }))
    expect(await resolveOrv(chain, 'alice.orv')).toEqual({ ownerDefault: null, records: [], provenance: { by: 'Orivon ID', proven: false, block: 26357300 } })
  })

  it('leaves out a record the browser would not load, and answers the rest', async () => {
    const texts = { 'content.ipfs': 'ipfs://bafy with space', 'content.https': 'http://example.com/', 'content.ddoc': 'x'.repeat(3000), 'content.arw': 'ar://' + 'A'.repeat(43) }
    const { chain } = fakeOrv(world({ resolvers: { [RES_A]: { contenthash: '0xbc03aabb', texts } } }))
    const answer = await resolveOrv(chain, 'alice.orv')
    expect(answer.ownerDefault).toBeNull()
    expect(answer.records).toEqual([{ type: 'arw', value: 'ar://' + 'A'.repeat(43) }])
  })
})

describe('resolveOrv: a name its owner does not control alone is not found', () => {
  it('finds nothing for a label nobody holds, and does not ask a resolver', async () => {
    const { chain, calls } = fakeOrv(world({ names: {} }))
    expect(await resolveOrv(chain, 'alice.orv')).toMatchObject({ ownerDefault: null, records: [] })
    expect(calls.some((call) => call.to === RES_A)).toBe(false)
  })

  it('finds nothing when someone else holds a role on the label, and does not ask the resolver', async () => {
    const shared = fakeOrv(world({ names: { alice: { owner: ALICE, resolver: RES_A, roleCount: (1n << 20n) + (1n << 5n), roles: { [ALICE]: 1n << 20n, [BOB]: 1n << 5n } } } }))
    expect(await resolveOrv(shared.chain, 'alice.orv')).toMatchObject({ ownerDefault: null, records: [] })
    expect(shared.calls.some((call) => call.to === RES_A)).toBe(false)
  })

  it('finds nothing when the holder lacks a role the count includes', async () => {
    const partial = fakeOrv(world({ names: { alice: { owner: ALICE, resolver: RES_A, roleCount: 3n, roles: { [ALICE]: 1n } } } }))
    expect(await resolveOrv(partial.chain, 'alice.orv')).toMatchObject({ ownerDefault: null, records: [] })
  })

  it('answers when the holder has every role there is, whatever the roles are', async () => {
    const own = fakeOrv(world({ names: { alice: { owner: ALICE, resolver: RES_A, roleCount: 0x1111n, roles: { [ALICE]: 0x1111n } } } }))
    expect(await resolveOrv(own.chain, 'alice.orv')).toMatchObject(FULL_ANSWER)
  })

  it('finds nothing when the label has no resolver, and for a reserved label the Safe holds', async () => {
    const none = fakeOrv(world({ names: { alice: { owner: ALICE }, orivon: { owner: ADDRESSES.safe } } }))
    expect(await resolveOrv(none.chain, 'alice.orv')).toMatchObject({ ownerDefault: null, records: [] })
    expect(await resolveOrv(none.chain, 'orivon.orv')).toMatchObject({ ownerDefault: null, records: [] })
  })

  it('makes no call at all for a label that fails isValidLabel', async () => {
    const { chain, calls } = fakeOrv(world({ names: { ab: { owner: ALICE, resolver: RES_A } } }))
    for (const name of ['ab.orv', 'xn--abc.orv', 'café.orv']) expect(await resolveOrv(chain, name)).toMatchObject({ ownerDefault: null, records: [] })
    expect(calls).toEqual([])
  })
})

describe('resolveOrv: a name below the sold one', () => {
  const nested = (): OrvWorld => world({
    names: { alice: { owner: ALICE, resolver: RES_A } },
    resolvers: {
      [RES_A]: { contenthash: IPFS_HASH, texts: { 'content.https': 'https://example.com/alice' } },
      [RES_D]: { texts: { 'content.https': 'https://example.com/docs' } }
    },
    registries: { [ADDRESSES.r1.toLowerCase()]: { alice: { subregistry: SUB_A } }, [SUB_A.toLowerCase()]: { docs: { resolver: RES_D } } }
  })

  it('uses the resolver of the deepest label, and asks it for the whole name', async () => {
    const { chain, calls } = fakeOrv(nested())
    const answer = await resolveOrv(chain, 'docs.alice.orv')
    expect(answer.records).toEqual([{ type: 'https', value: 'https://example.com/docs' }])
    expect(answer.ownerDefault).toBeNull()
    const asked = calls.find((call) => call.to === RES_D && call.selector === '9061b923')
    expect(decode(['bytes', 'bytes'], asked!.data.subarray(4))[0]).toEqual(dnsEncode('docs.alice.v1.orivonid.eth'))
    expect(calls.filter((call) => call.to === RES_A && call.selector !== '01ffc9a7')).toEqual([])
  })

  it('walks three levels of subregistries', async () => {
    const deep = nested()
    deep.registries![SUB_A.toLowerCase()] = { docs: { subregistry: SUB_D } }
    deep.registries![SUB_D.toLowerCase()] = { v2: { resolver: RES_D } }
    const { chain } = fakeOrv(deep)
    expect((await resolveOrv(chain, 'v2.docs.alice.orv')).records).toEqual([{ type: 'https', value: 'https://example.com/docs' }])
  })

  it('uses the resolver of the label above when the deeper label has none and that resolver is ENSIP-10', async () => {
    const { chain, calls } = fakeOrv(nested())
    const answer = await resolveOrv(chain, 'blog.alice.orv')
    expect(answer.ownerDefault).toEqual({ type: 'ipfs', value: IPFS_ADDRESS })
    const asked = calls.find((call) => call.to === RES_A && call.selector === '9061b923')
    expect(decode(['bytes', 'bytes'], asked!.data.subarray(4))[0]).toEqual(dnsEncode('blog.alice.v1.orivonid.eth'))
  })

  it('uses the resolver of the label above when the name has no subregistry, if that resolver is ENSIP-10', async () => {
    const { chain } = fakeOrv(world())
    expect((await resolveOrv(chain, 'blog.alice.orv')).ownerDefault).toEqual({ type: 'ipfs', value: IPFS_ADDRESS })
  })

  it('finds nothing when the only resolver is above the name and does not take ENSIP-10', async () => {
    const { chain } = fakeOrv(world({ resolvers: { [RES_A]: { extended: false, contenthash: IPFS_HASH } } }))
    expect(await resolveOrv(chain, 'blog.alice.orv')).toMatchObject({ ownerDefault: null, records: [] })
  })

  it('does not ask a subregistry before the owner is known to control the label alone', async () => {
    const shared = nested()
    shared.names.alice = { owner: ALICE, resolver: RES_A, roleCount: 3n, roles: { [ALICE]: 1n } }
    const { chain, calls } = fakeOrv(shared)
    expect(await resolveOrv(chain, 'docs.alice.orv')).toMatchObject({ ownerDefault: null, records: [] })
    expect(calls.some((call) => call.to.toLowerCase() === SUB_A.toLowerCase())).toBe(false)
  })

  it('treats a subregistry that reverts as the end of the path', async () => {
    const broken = nested()
    broken.registries![ADDRESSES.r1.toLowerCase()] = { alice: { subregistry: address(0xdead) } }
    const { chain } = fakeOrv(broken)
    expect((await resolveOrv(chain, 'docs.alice.orv')).ownerDefault).toEqual({ type: 'ipfs', value: IPFS_ADDRESS })
  })
})

describe('resolveOrv: failures are thrown and absences are answered', () => {
  it('throws when the node cannot answer, so the router can go on', async () => {
    const { chain } = fakeOrv(world())
    const down = { ...chain, blockNumber: async () => { throw new ChainError('unavailable', 'no node') } } as typeof chain
    await expect(resolveOrv(down, 'alice.orv')).rejects.toMatchObject({ reason: 'unavailable' })
    const slow = { ...chain, call: async () => { throw new ChainError('timeout', 'too slow') } } as typeof chain
    await expect(resolveOrv(slow, 'alice.orv')).rejects.toMatchObject({ reason: 'timeout' })
  })

  it('throws when the registry itself will not answer, instead of saying the name is not there', async () => {
    const { chain } = fakeOrv(world())
    const broken = { ...chain, call: async () => ({ data: null, revert: new Uint8Array(0), offchainLookup: null }) } as typeof chain
    await expect(resolveOrv(broken, 'alice.orv')).rejects.toMatchObject({ reason: 'reverted' })
    const empty = { ...chain, call: async () => ({ data: new Uint8Array(0), revert: null, offchainLookup: null }) } as typeof chain
    await expect(resolveOrv(empty, 'alice.orv')).rejects.toMatchObject({ reason: 'badAnswer' })
  })

  it('throws when the resolver could not answer any record, instead of saying the name has none', async () => {
    const { chain } = fakeOrv(world({ resolvers: { [RES_A]: { reverts: true } } }))
    await expect(resolveOrv(chain, 'alice.orv')).rejects.toMatchObject({ reason: 'unavailable' })
  })

  it('answers the records it could read when others failed', async () => {
    const { chain } = fakeOrv(world({ multicall: false, resolvers: { [RES_A]: { contenthash: IPFS_HASH, texts: TEXTS } } }))
    const answer = await resolveOrv(chain, 'alice.orv')
    expect(answer.ownerDefault).toEqual({ type: 'ipfs', value: IPFS_ADDRESS })
  })

  it('stops when the call is no longer wanted', async () => {
    const { chain } = fakeOrv(world())
    const controller = new AbortController()
    controller.abort(new Error('left'))
    await expect(resolveOrv(chain, 'alice.orv', { signal: controller.signal })).rejects.toThrow('left')
  })
})

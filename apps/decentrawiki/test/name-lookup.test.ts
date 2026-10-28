import { describe, expect, it } from 'vitest'
import { IpnsError, createRecord, generateNameKey, nameOf } from '../page/src/ipfs/ipns.js'
import { RECORD_GATEWAYS, findRecord, parseIpnsAddress, versionOf } from '../page/src/name-lookup.js'
import { PinningError } from '../page/src/publish/pinning.js'
import { keepName, keptRecord } from '../page/src/publish/relay-names.js'

const CID_A = 'bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am'
const CID_B = 'bafkreigkgwdvr5wspzwpiutssn4xpj2i7wedshnwphhnu7ohx4pqaxxipe'
const CID_C = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
const NOW = Date.parse('2026-10-26T22:00:00Z')
const RELAY = 'https://pin.example/decentrawiki'
type Body = ConstructorParameters<typeof Response>[0]
const [ORBITOR, FILEBASE] = RECORD_GATEWAYS as [string, string]
// Kubo 0.43.1: the name of a key, in base36 and in base32.
const KUBO_NAME = 'k51qzi5uqu5dgh3vf75s4r3b1tmvxytqag9c97dmnqy75fs1vlne9ovykd6tuy'
const KUBO_BASE32 = 'bafzaajaiaejcac5y7rmhk67f2nznpoky2busr7hzty4x54mf3xkdnaebvlg2zonk'
const KUBO_PEER_ID = '12D3KooWAc8Fnm1X73XK7q72ZnV2qo3fPnxE6TALPvGsvLVEF9u3'

describe('the forms of an IPNS address', () => {
  it('reads every form to the same name', () => {
    for (const text of [
      `ipns://${KUBO_NAME}`, `ipns://${KUBO_NAME}/`, `IPNS://${KUBO_NAME}`, `  ipns://${KUBO_NAME}/  `, `/ipns/${KUBO_NAME}`,
      `https://${KUBO_NAME}.ipns.dweb.link/`, `https://${KUBO_NAME}.ipns.localhost:8080/`,
      `https://ipfs.io/ipns/${KUBO_NAME}/`, `https://gateway.example/ipns/${KUBO_NAME}`,
      `ipns://${KUBO_BASE32}`, `ipns://${KUBO_PEER_ID}`
    ]) {
      expect(parseIpnsAddress(text), text).toEqual({ name: KUBO_NAME, path: 'index.html' })
    }
  })

  it('reads the path after the name, and defaults to the index page', () => {
    expect(parseIpnsAddress(`ipns://${KUBO_NAME}/docs/`)).toEqual({ name: KUBO_NAME, path: 'docs/index.html' })
    expect(parseIpnsAddress(`ipns://${KUBO_NAME}/a%20b.html?x=1#y`)).toEqual({ name: KUBO_NAME, path: 'a b.html' })
    expect(parseIpnsAddress(`https://${KUBO_NAME}.ipns.dweb.link/wiki.html`)).toEqual({ name: KUBO_NAME, path: 'wiki.html' })
  })

  it('answers null for what is no IPNS address, so the IPFS reader gets it', () => {
    for (const text of ['', 'hello', 'ipns://', 'https://example.org/', 'https://wiki.ipns.example.org/', `ipfs://${CID_A}`, CID_A, `https://${CID_A}.ipfs.dweb.link/`, `https://ipfs.io/ipfs/${CID_A}/`]) {
      expect(parseIpnsAddress(text), text).toBeNull()
    }
  })

  it('refuses an ipns:// address whose name is not one, in words', () => {
    for (const text of ['ipns://not-a-name', `ipns://${CID_A}`, '/ipns/k51damaged']) {
      let thrown: unknown
      try { parseIpnsAddress(text) } catch (error) { thrown = error }
      expect(thrown, text).toBeInstanceOf(IpnsError)
      expect((thrown as IpnsError).message.length).toBeGreaterThan(20)
    }
  })

  it('reads the version a record points at only when it is a bare /ipfs/<cid>', () => {
    expect(versionOf(`/ipfs/${CID_A}`)).toBe(CID_A)
    expect(versionOf(`/ipfs/${CID_A}/`)).toBe(CID_A)
    for (const value of [`/ipfs/${CID_A}/wiki/index.html`, `/ipns/${KUBO_NAME}`, '/ipfs/not-a-cid', CID_A, '']) expect(versionOf(value), value).toBeNull()
  })
})

interface Held { name: string, seed: Uint8Array }

async function key (): Promise<Held> {
  const { seed, publicKey } = await generateNameKey()
  return { name: nameOf(publicKey), seed }
}

async function record (held: Held, value: string, sequence: number, validity = new Date(NOW + 86_400_000)): Promise<Uint8Array> {
  return await createRecord({ seed: held.seed, value, sequence, validity, ttlMs: 300_000 })
}

type Answer = Response | Error | 'hang'
/** A fetch that answers by address: the relay's `name/record` and each gateway's `/ipns/<name>`. */
function sources (held: Held, answers: { relay?: Answer, orbitor?: Answer, filebase?: Answer }) {
  const urls = {
    [`${RELAY}/api/v0/name/record?arg=${held.name}`]: answers.relay,
    [`${ORBITOR}/ipns/${held.name}`]: answers.orbitor,
    [`${FILEBASE}/ipns/${held.name}`]: answers.filebase
  }
  const asked: { url: string, method: string, accept: string | null }[] = []
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    asked.push({ url, method: String(init.method ?? 'GET'), accept: new Headers(init.headers).get('accept') })
    const answer = (urls as Record<string, Answer | undefined>)[url] ?? new Error(`no route for ${url}`)
    if (answer === 'hang') {
      return await new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    }
    if (answer instanceof Error) throw answer
    return answer.clone()
  }) as unknown as typeof fetch
  return { fetchImpl, asked }
}

const bytesOf = (data: Uint8Array) => new Response(data as Body, { status: 200 })
const find = (held: Held, fetchImpl: typeof fetch, extra = {}) => findRecord(held.name, { fetchImpl, now: NOW, endpoint: RELAY, timeoutMs: 400, ...extra })

describe('finding what an address shows', () => {
  it('takes the highest sequence among the sources that verify, and asks each the way it answers', async () => {
    const held = await key()
    const { fetchImpl, asked } = sources(held, {
      relay: bytesOf(await record(held, `/ipfs/${CID_A}`, 5)),
      orbitor: bytesOf(await record(held, `/ipfs/${CID_B}`, 9)),
      filebase: bytesOf(await record(held, `/ipfs/${CID_C}`, 7))
    })
    const found = await find(held, fetchImpl)
    expect(found).toMatchObject({ cid: CID_B, source: ORBITOR })
    expect(found?.record.sequence).toBe(9)
    expect(asked).toHaveLength(3)
    expect(asked.find((call) => call.url.startsWith(RELAY))).toMatchObject({ method: 'POST' })
    expect(asked.find((call) => call.url.startsWith(ORBITOR))).toMatchObject({ method: 'GET', accept: 'application/vnd.ipfs.ipns-record' })
  })

  it('ignores a forged record, an expired one and one that points at something else, however high their sequence', async () => {
    const held = await key()
    const stranger = await key()
    const forged = await record(stranger, `/ipfs/${CID_B}`, 99)
    const expired = await record(held, `/ipfs/${CID_B}`, 98, new Date(NOW - 1000))
    const elsewhere = await record(held, `/ipfs/${CID_B}/wiki/index.html`, 97)
    const notIpfs = await record(held, `/ipns/${stranger.name}`, 96)
    const honest = await record(held, `/ipfs/${CID_A}`, 3)
    for (const bad of [forged, expired, elsewhere, notIpfs]) {
      const { fetchImpl } = sources(held, { relay: bytesOf(bad), orbitor: bytesOf(honest), filebase: new Response('', { status: 404 }) })
      expect((await find(held, fetchImpl))?.cid).toBe(CID_A)
    }
    const { fetchImpl } = sources(held, { relay: bytesOf(forged), orbitor: bytesOf(expired), filebase: bytesOf(elsewhere) })
    expect(await find(held, fetchImpl)).toBeNull()
  })

  it('ignores a record changed after signing and bytes that are no record', async () => {
    const held = await key()
    const changed = await record(held, `/ipfs/${CID_A}`, 3)
    changed[changed.length - 3] = (changed[changed.length - 3] as number) ^ 1
    const { fetchImpl } = sources(held, { relay: bytesOf(changed), orbitor: bytesOf(new Uint8Array([1, 2, 3])), filebase: bytesOf(new Uint8Array(0)) })
    expect(await find(held, fetchImpl)).toBeNull()
  })

  it('finds nothing when every source answered and none holds a record', async () => {
    const held = await key()
    const none = () => new Response('not found', { status: 404 })
    expect(await find(held, sources(held, { relay: none(), orbitor: none(), filebase: none() }).fetchImpl)).toBeNull()
  })

  it('goes on with the sources that answer when one fails or never does', async () => {
    const held = await key()
    const honest = bytesOf(await record(held, `/ipfs/${CID_A}`, 3))
    const failing = sources(held, { relay: new Response('', { status: 503 }), orbitor: new Error('connection reset'), filebase: honest })
    expect((await find(held, failing.fetchImpl))?.source).toBe(FILEBASE)
    const hanging = sources(held, { relay: 'hang', orbitor: 'hang', filebase: honest.clone() })
    expect((await find(held, hanging.fetchImpl, { timeoutMs: 80 }))?.cid).toBe(CID_A)
  })

  it('says so when no source could be asked', async () => {
    const held = await key()
    const down = sources(held, { relay: new Error('offline'), orbitor: new Response('', { status: 525 }), filebase: 'hang' })
    await expect(find(held, down.fetchImpl, { timeoutMs: 80 })).rejects.toThrow('Could not ask Orivon')
  })

  it('refuses a record larger than a record may be', async () => {
    const held = await key()
    const huge = new Response(new Uint8Array(20_000) as Body, { status: 200 })
    const { fetchImpl } = sources(held, { relay: huge.clone(), orbitor: huge.clone(), filebase: huge.clone() })
    expect(await find(held, fetchImpl)).toBeNull()
  })
})

function relay(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string, init: RequestInit }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(typeof body === 'string' || body instanceof Uint8Array ? body as Body : JSON.stringify(body), { status, headers })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('keeping an address on Orivon\'s node', () => {
  const sent = new Uint8Array([1, 2, 3, 4])

  it('sends the record as it is and reads when the address is kept until', async () => {
    const { fetchImpl, calls } = relay(200, { Name: KUBO_NAME, Value: `/ipfs/${CID_A}`, Sequence: 12, KeptUntil: '2026-11-25T22:00:00.000Z' })
    const kept = await keepName({ endpoint: `${RELAY}/`, name: KUBO_NAME, record: sent, expect: { value: `/ipfs/${CID_A}`, sequence: 12 }, fetchImpl })
    expect(kept).toEqual({ value: `/ipfs/${CID_A}`, sequence: 12, keptUntil: Date.parse('2026-11-25T22:00:00.000Z') })
    expect(calls[0]?.url).toBe(`${RELAY}/api/v0/name/keep?arg=${KUBO_NAME}`)
    expect(calls[0]?.init.method).toBe('POST')
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('application/vnd.ipfs.ipns-record')
    expect(calls[0]?.init.body).toBe(sent)
  })

  it('names the page\'s own IPFS node when it has one, so Orivon\'s node reads the version from it', async () => {
    const peer = '12D3KooWBFpVc6cRWcWt72deRUy5SG2Ezcb4w3XqJF9pxp9WE7ne'
    const { fetchImpl, calls } = relay(200, { Name: KUBO_NAME, Value: `/ipfs/${CID_A}`, Sequence: 12, KeptUntil: '2026-11-25T22:00:00.000Z' })
    await keepName({ endpoint: RELAY, name: KUBO_NAME, record: sent, peer, fetchImpl })
    expect(calls[0]?.url).toBe(`${RELAY}/api/v0/name/keep?arg=${KUBO_NAME}&peer=${peer}`)
    await keepName({ endpoint: RELAY, name: KUBO_NAME, record: sent, fetchImpl })
    expect(calls[1]?.url).toBe(`${RELAY}/api/v0/name/keep?arg=${KUBO_NAME}`)
  })

  it('shows the relay\'s own words for each refusal', async () => {
    const refusals: [number, string][] = [
      [400, 'That is not a record DecentraWiki can keep.'],
      [409, 'A newer record for this address is already kept.'],
      [410, 'That record has run out.'],
      [413, 'That record is larger than a record may be.'],
      [429, 'Orivon\'s node keeps only so many addresses a day. Try again tomorrow.'],
      [502, 'Orivon\'s node could not read that version from IPFS.'],
      [503, 'Orivon\'s node is not reachable right now.'],
      [504, 'Reading that version took too long. Try again.']
    ]
    for (const [status, said] of refusals) {
      const { fetchImpl } = relay(status, { Message: said, Code: 0, Type: 'error' })
      const error = await keepName({ endpoint: RELAY, name: KUBO_NAME, record: sent, fetchImpl }).catch((caught: unknown) => caught as PinningError)
      expect(error, String(status)).toBeInstanceOf(PinningError)
      expect((error as PinningError).message, String(status)).toBe(said)
      expect((error as PinningError).kind).toBe(status === 413 ? 'too-large' : 'refused')
    }
  })

  it('still says something when the refusal has no words', async () => {
    const { fetchImpl } = relay(502, '<html>Bad gateway</html>')
    await expect(keepName({ endpoint: RELAY, name: KUBO_NAME, record: sent, fetchImpl })).rejects.toThrow('status 502')
  })

  it('says it could not reach the relay, and when the request was cancelled', async () => {
    const down = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    await expect(keepName({ endpoint: RELAY, name: KUBO_NAME, record: sent, fetchImpl: down })).rejects.toMatchObject({ kind: 'unreachable' })
    const controller = new AbortController()
    controller.abort()
    await expect(keepName({ endpoint: RELAY, name: KUBO_NAME, record: sent, fetchImpl: down, signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted' })
  })

  it('gives up when the relay does not answer in time', async () => {
    const slow = (async (_url: string, init: RequestInit) => await new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch
    const error = await keepName({ endpoint: RELAY, name: KUBO_NAME, record: sent, fetchImpl: slow, timeoutMs: 40 }).catch((caught: unknown) => caught as PinningError)
    expect(error).toMatchObject({ kind: 'unreachable' })
    expect((error as PinningError).message).toContain('did not answer in time')
  })

  it('does not take a success that is about another record or says nothing usable', async () => {
    const other = relay(200, { Name: KUBO_NAME, Value: `/ipfs/${CID_B}`, Sequence: 12, KeptUntil: '2026-11-25T22:00:00.000Z' })
    await expect(keepName({ endpoint: RELAY, name: KUBO_NAME, record: sent, expect: { value: `/ipfs/${CID_A}`, sequence: 12 }, fetchImpl: other.fetchImpl })).rejects.toMatchObject({ kind: 'bad-answer' })
    const older = relay(200, { Name: KUBO_NAME, Value: `/ipfs/${CID_A}`, Sequence: 11, KeptUntil: '2026-11-25T22:00:00.000Z' })
    await expect(keepName({ endpoint: RELAY, name: KUBO_NAME, record: sent, expect: { value: `/ipfs/${CID_A}`, sequence: 12 }, fetchImpl: older.fetchImpl })).rejects.toMatchObject({ kind: 'bad-answer' })
    for (const body of [{}, { Value: `/ipfs/${CID_A}` }, { Value: `/ipfs/${CID_A}`, KeptUntil: 'someday' }, 'nonsense']) {
      await expect(keepName({ endpoint: RELAY, name: KUBO_NAME, record: sent, fetchImpl: relay(200, body).fetchImpl })).rejects.toMatchObject({ kind: 'bad-answer' })
    }
  })

  it('asks for the newest record it holds, and treats a missing one as none', async () => {
    const held = new Uint8Array([9, 8, 7])
    const { fetchImpl, calls } = relay(200, held)
    expect(await keptRecord({ endpoint: RELAY, name: KUBO_NAME, fetchImpl })).toEqual(held)
    expect(calls[0]?.url).toBe(`${RELAY}/api/v0/name/record?arg=${KUBO_NAME}`)
    expect(calls[0]?.init.method).toBe('POST')
    expect(await keptRecord({ endpoint: RELAY, name: KUBO_NAME, fetchImpl: relay(404, { Message: 'none' }).fetchImpl })).toBeNull()
    await expect(keptRecord({ endpoint: RELAY, name: KUBO_NAME, fetchImpl: relay(503, { Message: 'Orivon\'s node is not reachable right now.' }).fetchImpl })).rejects.toThrow('not reachable')
    await expect(keptRecord({ endpoint: RELAY, name: KUBO_NAME, fetchImpl: relay(200, new Uint8Array(20_000)).fetchImpl })).rejects.toMatchObject({ kind: 'bad-answer' })
  })
})

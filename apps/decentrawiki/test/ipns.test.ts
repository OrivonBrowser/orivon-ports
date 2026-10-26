import { describe, expect, it } from 'vitest'
import { base32Encode } from '../page/src/ipfs/cid.js'
import {
  IPNS_RECORD_TYPE, IpnsError, MAX_RECORD_BYTES, createRecord, decodeKeyFile, encodeKeyFile, generateNameKey,
  nameOf, parseName, parseRecord, publicKeyOf, verifyRecord
} from '../page/src/ipfs/ipns.js'

// Everything below comes from Kubo 0.43.1 on a throwaway repository (offline, `IPFS_PATH` set):
// `ipfs key gen --type=ed25519 <key>`, `ipfs key export <key>` for the key file and
// `ipfs key export <key> --format=pem-pkcs8-cleartext` for the PEM, `ipfs name publish
// --allow-offline --key=<key> ...`, and the record bytes read back from the datastore.
// `ipfs name inspect --verify <name>` accepted both records.
interface Vector {
  name: string
  peerId: string
  base32: string
  keyFile: string
  pem: string
  record: string
  value: string
  sequence: number
  validity: string
  ttlMs: number
}

// `--lifetime=8760h --ttl=5m --sequence=7 /ipfs/<CID>`
const VECTOR: Vector = {
  name: 'k51qzi5uqu5dgh3vf75s4r3b1tmvxytqag9c97dmnqy75fs1vlne9ovykd6tuy',
  peerId: '12D3KooWAc8Fnm1X73XK7q72ZnV2qo3fPnxE6TALPvGsvLVEF9u3',
  base32: 'bafzaajaiaejcac5y7rmhk67f2nznpoky2busr7hzty4x54mf3xkdnaebvlg2zonk',
  keyFile: 'CAESQD3Huwe5KhRAWD+U8NOe5e4jWM3/CnpF5bXo/SMDpJeNC7j8WHV75dNy17lY0Gko/PmeOX7xhd3UNoCBqs2suao=',
  pem: `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEID3Huwe5KhRAWD+U8NOe5e4jWM3/CnpF5bXo/SMDpJeN
-----END PRIVATE KEY-----
`,
  record:
  'CkEvaXBmcy9iYWZrcmVpY3lzZzIza2l3djM0ZWcyZDdxd2VpcHh3b3NkbzJweTRsZHY0Mm5iYXVndWx1ZW41djZhbRJAcm/EPYgU' +
  'MKsuxsyN6bd9vWq+mU74JMutSvN/PEhPfmQRju8UXAX1Mp+cBvtNuoyPhmmKS/vIdVqb6m9Jp7+uDRgAIh0yMDI3LTEwLTI2VDIx' +
  'OjExOjMyLjA4NDcwMzI3WigHMIDwksvdCEJAfo7aMbV5k4Yt+jQxvMa35f7kEz0oyJqn9UtkFD0Q13sat2M+4wDcCREOkaj3+sip' +
  'xqKrdQDNWR2AEM4f3szFBEqXAaVjVFRMGwAAAEXZZLgAZVZhbHVlWEEvaXBmcy9iYWZrcmVpY3lzZzIza2l3djM0ZWcyZDdxd2Vp' +
  'cHh3b3NkbzJweTRsZHY0Mm5iYXVndWx1ZW41djZhbWhTZXF1ZW5jZQdoVmFsaWRpdHlYHTIwMjctMTAtMjZUMjE6MTE6MzIuMDg0' +
  'NzAzMjdabFZhbGlkaXR5VHlwZQA=',
  value: '/ipfs/bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am',
  sequence: 7,
  validity: '2027-10-26T21:11:32.08470327Z',
  ttlMs: 300_000
}

// `--lifetime=48h --ttl=1h --resolve=false /ipfs/<CID>/wiki/index.html`, no `--sequence`
const VECTOR_PATH: Vector = {
  name: 'k51qzi5uqu5dj62xvfnp4n0msn0c139y2i865g2uoyrfcpfdje725ljlg6y7i7',
  peerId: '12D3KooWHt1vfo712dW6uQQqmD1cvQAqSDENUnPuyYYmHnAiX7aE',
  base32: 'bafzaajaiaejca56m5yqoczz3dtch2uqa5uvrwasrx7fbg5vvv5rgl323oazxa4d7',
  keyFile: 'CAESQOku7FLiEpZPpBuSr/dSZbDbDEk4gyRILm86oNd2Ik3fd8zuIOFnOxzEfVIA7SsbAlG/yhN2ta9iZe9bcDNwcH8=',
  pem: `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIOku7FLiEpZPpBuSr/dSZbDbDEk4gyRILm86oNd2Ik3f
-----END PRIVATE KEY-----
`,
  record:
  'ClEvaXBmcy9iYWZrcmVpY3lzZzIza2l3djM0ZWcyZDdxd2VpcHh3b3NkbzJweTRsZHY0Mm5iYXVndWx1ZW41djZhbS93aWtpL2lu' +
  'ZGV4Lmh0bWwSQOBxgfzXzxoqDxtOd5KLJgj/p9qt21xYJYRF9t7PwFOh+szqApfAQXFtTXpCFtALzVqQUxK6dTZH3X0soBrM8QEY' +
  'ACIeMjAyNi0xMC0yOFQyMToxMzowMS4yODgxODIxOThaKAAwgMDiheNoQkBDMv7yD20KjvFdKn2FJd+6Hfet8lQu/ibTJpf3uOK6' +
  'W6mmnRm4hzt33NSK9T/1b/ql0R1Ueg4oe4qkKZouxOkASqgBpWNUVEwbAAADRjC4oABlVmFsdWVYUS9pcGZzL2JhZmtyZWljeXNn' +
  'MjNraXd2MzRlZzJkN3F3ZWlweHdvc2RvMnB5NGxkdjQybmJhdWd1bHVlbjV2NmFtL3dpa2kvaW5kZXguaHRtbGhTZXF1ZW5jZQBo' +
  'VmFsaWRpdHlYHjIwMjYtMTAtMjhUMjE6MTM6MDEuMjg4MTgyMTk4WmxWYWxpZGl0eVR5cGUA',
  value: '/ipfs/bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am/wiki/index.html',
  sequence: 0,
  validity: '2026-10-28T21:13:01.288182198Z',
  ttlMs: 3_600_000
}

// Names and keys of the other key types `ipfs key gen` makes: secp256k1 inlines its key in the
// name like Ed25519 does, RSA names hash the key.
const SECP256K1_NAME = 'kzwfwjn5ji4puruondz9h4aohksxy8qg52f6wjy7pjln7q51s4mf6omxv7d67on'
const RSA_NAME = 'k2k4r8m3j5vitdoc1p32wyf7n3ire34rbwf1ckfgfjd8sdh45q9sa70l'
const SECP256K1_KEY_FILE = 'CAISIMFczv79WASmS2x6Enqh2w8vFRS41VyE/6T23p964X3L'
const SECP256K1_PEM = `-----BEGIN PRIVATE KEY-----
MIGEAgEAMBAGByqGSM49AgEGBSuBBAAKBG0wawIBAQQgwVzO/v1YBKZLbHoSeqHb
Dy8VFLjVXIT/pPben3rhfcuhRANCAARIMD/PftEWISUuOSZYGW98bF2HPu2WsRiK
LlLigGtFZ8KiIBi6rmKqlWyhWUe8eAa0jPDchCdJlTL1IIkEUGTn
-----END PRIVATE KEY-----
`

// The same key as VECTOR_PATH, published with `--v1compat=false --lifetime=24h --ttl=5m --sequence=3`:
// only the V2 fields, so no value, validity or V1 signature outside the signed data.
const V2_ONLY_RECORD = 'QkCSyhUfLnS3+/prRJ2VSGbduURVKmRpTwRew7lUAsg1M+lU4eG0uvwKevCtSugpQEuVAFuPn93Mev1/tpeSra8BSpgBpWNUVEwbAAAARdlkuABlVmFsdWVYQS9pcGZzL2JhZmtyZWljeXNnMjNraXd2MzRlZzJkN3F3ZWlweHdvc2RvMnB5NGxkdjQybmJhdWd1bHVlbjV2NmFtaFNlcXVlbmNlA2hWYWxpZGl0eVgeMjAyNi0xMC0yN1QyMToyMzoyMS44ODY1MTAwMDNabFZhbGlkaXR5VHlwZQA='

const NOW = Date.parse('2026-10-26T22:00:00Z')
const bytes = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'))
const text = (value: string) => new TextEncoder().encode(value)
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0

function join(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts))
}

function find(haystack: Uint8Array, needle: Uint8Array): number {
  const at = Buffer.from(haystack).indexOf(needle)
  if (at < 0) throw new Error('needle not found')
  return at
}

function flip(source: Uint8Array, index: number): Uint8Array {
  const copy = source.slice()
  copy[index] = (copy[index] as number) ^ 1
  return copy
}

/** The record with its signed data swapped, the rest (signatures included) untouched. */
function withData(record: Uint8Array, data: Uint8Array): Uint8Array {
  const old = parseRecord(record).data
  const lengthBytes = old.length < 128 ? 1 : 2
  const prefix = record.subarray(0, record.length - old.length - lengthBytes - 1)
  const length = data.length < 128 ? [data.length] : [(data.length & 0x7f) | 0x80, data.length >> 7]
  return join(prefix, Uint8Array.of(0x4a, ...length), data)
}

function replace(source: Uint8Array, from: ArrayLike<number>, to: ArrayLike<number>): Uint8Array {
  const at = find(source, Uint8Array.from(from))
  return join(source.subarray(0, at), Uint8Array.from(to), source.subarray(at + from.length))
}

function refusalSync(run: () => unknown): { kind: string, message: string } {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(IpnsError)
    const { kind, message } = error as IpnsError
    return { kind, message }
  }
  throw new Error('expected a refusal')
}

async function refusal(run: () => unknown): Promise<{ kind: string, message: string }> {
  try {
    await run()
  } catch (error) {
    return refusalSync(() => { throw error })
  }
  throw new Error('expected a refusal')
}

const VECTORS = [VECTOR, VECTOR_PATH]

describe('constants', () => {
  it('names the record type and the size limit', () => {
    expect(IPNS_RECORD_TYPE).toBe('application/vnd.ipfs.ipns-record')
    expect(MAX_RECORD_BYTES).toBe(10240)
  })
})

describe.each(VECTORS)('Kubo vector $name', (vector) => {
  it('reads the key file and its PEM alike, and names the key as Kubo does', async () => {
    const fromFile = await decodeKeyFile(bytes(vector.keyFile))
    const fromPem = await decodeKeyFile(text(vector.pem))
    expect(same(fromFile.seed, fromPem.seed)).toBe(true)
    expect(same(fromFile.publicKey, fromPem.publicKey)).toBe(true)
    expect(nameOf(fromFile.publicKey)).toBe(vector.name)
    expect(same(await publicKeyOf(fromFile.seed), fromFile.publicKey)).toBe(true)
    expect(same(encodeKeyFile(fromFile.seed, fromFile.publicKey), bytes(vector.keyFile))).toBe(true)
  })

  it('parses the record Kubo wrote', () => {
    const record = parseRecord(bytes(vector.record))
    expect(record.value).toBe(vector.value)
    expect(record.sequence).toBe(vector.sequence)
    expect(record.validity).toBe(vector.validity)
    expect(record.validUntil).toBe(Date.parse(vector.validity.replace(/(\.\d{3})\d*Z$/, '$1Z')))
    expect(record.ttlMs).toBe(vector.ttlMs)
    expect(record.signatureV2).toHaveLength(64)
    expect(record.signatureV1).toHaveLength(64)
    expect(record.pubKey).toBeNull()
  })

  it('verifies the record against the name, until it runs out', async () => {
    const record = bytes(vector.record)
    expect(await verifyRecord(record, vector.name, { now: NOW })).toEqual(parseRecord(record))
    const { kind } = await refusal(() => verifyRecord(record, vector.name, { now: parseRecord(record).validUntil }))
    expect(kind).toBe('expired')
  })

  it('writes the record byte for byte as Kubo does', async () => {
    const { seed } = await decodeKeyFile(bytes(vector.keyFile))
    const mine = await createRecord({
      seed, value: vector.value, sequence: vector.sequence, validity: vector.validity, ttlMs: vector.ttlMs
    })
    expect(Buffer.from(mine).toString('base64')).toBe(vector.record.replace(/\s/g, ''))
  })

  it('spells the name in every form', () => {
    const { publicKey } = parseName(vector.name)
    for (const spelling of [vector.name, vector.base32, vector.peerId, `  ${vector.name}\n`]) {
      const parsed = parseName(spelling)
      expect(parsed.name).toBe(vector.name)
      expect(same(parsed.publicKey, publicKey)).toBe(true)
    }
  })
})

describe('a record with only the V2 fields', () => {
  it('reads and verifies', async () => {
    const parsed = await verifyRecord(bytes(V2_ONLY_RECORD), VECTOR_PATH.name, { now: NOW })
    expect(parsed.value).toBe('/ipfs/bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am')
    expect(parsed.sequence).toBe(3)
    expect(parsed.ttlMs).toBe(300_000)
    expect(parsed.validity).toBe('2026-10-27T21:23:21.886510003Z')
    expect(parsed.validUntil).toBe(Date.parse('2026-10-27T21:23:21.886Z'))
    expect(parsed.signatureV1).toBeNull()
    expect(parsed.pubKey).toBeNull()
  })
})

describe('a fresh key', () => {
  it('generates, names, signs and verifies', async () => {
    const { seed, publicKey } = await generateNameKey()
    expect(seed).toHaveLength(32)
    expect(publicKey).toHaveLength(32)
    expect(same(await publicKeyOf(seed), publicKey)).toBe(true)
    const name = nameOf(publicKey)
    expect(name).toMatch(/^k51qzi5uqu5d[0-9a-z]{50}$/)

    const validity = new Date(NOW + 86_400_000)
    const bytesOut = await createRecord({ seed, value: '/ipfs/bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am', sequence: 1, validity, ttlMs: 60_000 })
    const record = await verifyRecord(bytesOut, name, { now: NOW })
    expect(record.sequence).toBe(1)
    expect(record.ttlMs).toBe(60_000)
    expect(record.validity).toBe(validity.toISOString())
    expect(record.validUntil).toBe(validity.getTime())

    const restored = await decodeKeyFile(encodeKeyFile(seed, publicKey))
    expect(same(restored.seed, seed)).toBe(true)
  })

  it('carries a large sequence, a zero TTL and a long value', async () => {
    const { seed, publicKey } = await generateNameKey()
    const value = '/ipfs/bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am/' + 'a/'.repeat(1000)
    const made = await createRecord({ seed, value, sequence: Number.MAX_SAFE_INTEGER, validity: new Date(NOW + 1000), ttlMs: 0 })
    const record = await verifyRecord(made, nameOf(publicKey), { now: NOW })
    expect(record.value).toBe(value)
    expect(record.sequence).toBe(Number.MAX_SAFE_INTEGER)
    expect(record.ttlMs).toBe(0)
  })

  it('reads an expiry written with a zone offset', async () => {
    const { seed } = await generateNameKey()
    const made = await createRecord({ seed, value: '/ipfs/x', sequence: 0, validity: '2030-01-01T02:00:00.5+02:00', ttlMs: 1 })
    expect(parseRecord(made).validUntil).toBe(Date.parse('2030-01-01T00:00:00.500Z'))
  })

  it('refuses what it cannot write', async () => {
    const { seed } = await generateNameKey()
    const ok = { seed, value: '/ipfs/x', sequence: 1, validity: new Date(NOW), ttlMs: 1 }
    await expect(createRecord({ ...ok, sequence: -1 })).rejects.toThrow(RangeError)
    await expect(createRecord({ ...ok, sequence: 1.5 })).rejects.toThrow(RangeError)
    await expect(createRecord({ ...ok, sequence: 2 ** 53 })).rejects.toThrow(RangeError)
    await expect(createRecord({ ...ok, ttlMs: -1 })).rejects.toThrow(RangeError)
    await expect(createRecord({ ...ok, validity: '2030-02-30T00:00:00Z' })).rejects.toThrow(RangeError)
    await expect(createRecord({ ...ok, validity: 'tomorrow' })).rejects.toThrow(RangeError)
    await expect(createRecord({ ...ok, validity: new Date(Number.NaN) })).rejects.toThrow(RangeError)
    await expect(createRecord({ ...ok, seed: new Uint8Array(31) })).rejects.toThrow(RangeError)
    const { kind } = await refusal(() => createRecord({ ...ok, value: '/ipfs/' + 'a'.repeat(MAX_RECORD_BYTES) }))
    expect(kind).toBe('malformed')
  })
})

describe('refusing a record', () => {
  const record = bytes(VECTOR.record)
  const { data, signatureV2 } = parseRecord(record)

  it('refuses a changed signed byte, or a changed signature', async () => {
    const inData = find(record, data) + find(data, text(VECTOR.value)) + 10
    expect((await refusal(() => verifyRecord(flip(record, inData), VECTOR.name, { now: NOW }))).kind).toBe('signature')
    const inSignature = find(record, signatureV2) + 5
    expect((await refusal(() => verifyRecord(flip(record, inSignature), VECTOR.name, { now: NOW }))).kind).toBe('signature')
  })

  it('refuses a record checked against another name', async () => {
    expect((await refusal(() => verifyRecord(record, VECTOR_PATH.name, { now: NOW }))).kind).toBe('signature')
  })

  it('refuses an expired record unless asked to keep it', async () => {
    const late = parseRecord(record).validUntil + 1
    const { kind, message } = await refusal(() => verifyRecord(record, VECTOR.name, { now: late }))
    expect(kind).toBe('expired')
    expect(message).toContain(VECTOR.validity)
    expect((await verifyRecord(record, VECTOR.name, { now: late, allowExpired: true })).sequence).toBe(7)
  })

  it('refuses a V1 copy that differs from the signed data', async () => {
    const value = find(record, text(VECTOR.value))
    expect((await refusal(() => verifyRecord(flip(record, value + 8), VECTOR.name, { now: NOW }))).kind).toBe('mismatch')
    const sequence = replace(record, [0x28, 0x07, 0x30], [0x28, 0x08, 0x30])
    expect((await refusal(() => verifyRecord(sequence, VECTOR.name, { now: NOW }))).kind).toBe('mismatch')
    const validity = find(record, text(VECTOR.validity))
    expect((await refusal(() => verifyRecord(flip(record, validity + 2), VECTOR.name, { now: NOW }))).kind).toBe('mismatch')
    const ttl = replace(record, [0x30, 0x80, 0xf0, 0x92], [0x30, 0x80, 0xf0, 0x93])
    expect((await refusal(() => verifyRecord(ttl, VECTOR.name, { now: NOW }))).kind).toBe('mismatch')
  })

  it('takes a public key that is the name\'s own, and refuses another', async () => {
    const marshalled = (key: Uint8Array) => Uint8Array.of(0x08, 0x01, 0x12, 0x20, ...key)
    const own = parseName(VECTOR.name).publicKey
    const other = parseName(VECTOR_PATH.name).publicKey
    const withKey = (key: Uint8Array) => join(record, Uint8Array.of(0x3a, 36), marshalled(key))
    expect(parseRecord(withKey(own)).pubKey).toHaveLength(36)
    expect((await verifyRecord(withKey(own), VECTOR.name, { now: NOW })).sequence).toBe(7)
    expect((await refusal(() => verifyRecord(withKey(other), VECTOR.name, { now: NOW }))).kind).toBe('mismatch')
  })

  it('refuses garbage', async () => {
    const cases: Uint8Array[] = [
      new Uint8Array(0),
      text('not a record'),
      Uint8Array.of(0xff, 0xff, 0xff),
      record.subarray(0, record.length - 10),
      record.subarray(0, 100),
      new Uint8Array(MAX_RECORD_BYTES + 1).fill(0x20)
    ]
    for (const garbage of cases) {
      expect((await refusal(() => verifyRecord(garbage, VECTOR.name, { now: NOW }))).kind).toBe('malformed')
      expect(refusalSync(() => parseRecord(garbage)).kind).toBe('malformed')
    }
  })

  it('refuses a record with no V2 part, and says it is the old format when it is', async () => {
    const v1Only = record.subarray(0, find(record, signatureV2) - 2)
    expect((await refusal(() => verifyRecord(v1Only, VECTOR.name, { now: NOW }))).kind).toBe('unsupported')
    expect((await refusal(() => verifyRecord(Uint8Array.of(0x28, 0x07), VECTOR.name, { now: NOW }))).kind).toBe('malformed')
  })

  it('refuses signed data that is not what a record holds', () => {
    const cases: Array<[string, Uint8Array]> = [
      ['unknown validity type', replace(data, [0x6c, ...text('ValidityType'), 0x00], [0x6c, ...text('ValidityType'), 0x01])],
      ['sequence past 2^53', replace(data, [...text('Sequence'), 0x07], [...text('Sequence'), 0x1b, 0, 0x20, 0, 0, 0, 0, 0, 0])],
      ['integer not in its shortest form', replace(data, [...text('Sequence'), 0x07], [...text('Sequence'), 0x18, 0x07])],
      ['keys out of order', replace(data, text('Sequence'), text('Zequence'))],
      ['not a map', Uint8Array.of(0x80)],
      ['trailing bytes', join(data, Uint8Array.of(0x00))],
      ['a missing key', replace(replace(data, [0xa5], [0xa4]), [0x63, ...text('TTL'), 0x1b, 0, 0, 0, 0x45, 0xd9, 0x64, 0xb8, 0x00], [])]
    ]
    for (const [label, changed] of cases) {
      expect([label, refusalSync(() => parseRecord(withData(record, changed))).kind]).toEqual([label, 'malformed'])
    }
  })

  it('refuses an expiry that is not a time', () => {
    const changed = replace(data, text('2027-10-26T21:11:32.08470327Z'), text('2027-13-26T21:11:32.08470327Z'))
    expect(refusalSync(() => parseRecord(withData(record, changed))).message).toContain('not a time')
  })
})

describe('names', () => {
  it('refuses what is not an Ed25519 name', () => {
    const hashed = Uint8Array.of(1, 0x72, 0x12, 0x20, ...new Uint8Array(32).fill(7))
    for (const name of [RSA_NAME, SECP256K1_NAME, 'QmY9cxiHqTFoWamkQVkpmmqzBrY3hCBEL2XNu3NtX74Fuu', 'b' + base32Encode(hashed)]) {
      expect(refusalSync(() => parseName(name)).kind, name).toBe('unsupported')
    }
  })

  it('refuses what is not a name', () => {
    const bad = [
      '', '   ', 'hello', `ipns://${VECTOR.name}`, `/ipns/${VECTOR.name}`, VECTOR.name.toUpperCase(),
      VECTOR.name + 'a', VECTOR.name.slice(0, -2), VECTOR.peerId.slice(0, -1), 'k', 'k0',
      'bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am', 'x'.repeat(500)
    ]
    for (const input of bad) expect(refusalSync(() => parseName(input)).kind, input).toBe('malformed')
  })

  it('refuses a key that is not 32 bytes', () => {
    expect(() => nameOf(new Uint8Array(31))).toThrow(RangeError)
  })
})

describe('key files', () => {
  it('refuses a key of another kind', async () => {
    for (const file of [bytes(SECP256K1_KEY_FILE), text(SECP256K1_PEM), Uint8Array.of(0x08, 0x00, 0x12, 0x03, 1, 2, 3)]) {
      const { kind, message } = await refusal(() => decodeKeyFile(file))
      expect(kind).toBe('unsupported')
      expect(message).toMatch(/^This is not an IPNS key file DecentraWiki can use: /)
    }
  })

  it('refuses what is not a key file', async () => {
    const broken = [
      new Uint8Array(0), text('hello'), text('-----BEGIN PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----'),
      text('-----BEGIN PRIVATE KEY-----\nAAAA'), bytes(VECTOR.keyFile).subarray(0, 40), new Uint8Array(9000).fill(0x08)
    ]
    for (const file of broken) expect((await refusal(() => decodeKeyFile(file))).kind).toBe('malformed')
  })

  it('refuses a public key that is not the private key\'s', async () => {
    const file = bytes(VECTOR.keyFile)
    expect((await refusal(() => decodeKeyFile(flip(file, file.length - 1)))).kind).toBe('mismatch')
  })
})

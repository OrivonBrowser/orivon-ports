// secp256k1 for tests only: a key's address, a deterministic (RFC 6979) signature in the form a wallet gives, and
// recovery. BigInt arithmetic that takes time depending on the key, so it must never touch a real one. The Orivon
// wallet's own vectors (see sign-in.test.ts) check it against a signature made elsewhere.

import { createHmac } from 'node:crypto'
import { toChecksumAddress } from '../../site/sdk/abi.js'
import { concat, toHex } from '../../site/sdk/bytes.js'
import { keccak256 } from '../../site/sdk/keccak.js'

const P = 2n ** 256n - 2n ** 32n - 977n
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
type Point = { x: bigint, y: bigint } | null
const G: Point = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n
}

const mod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m
const bytesToInt = (bytes: Uint8Array): bigint => BigInt('0x' + (toHex(bytes) || '0'))
const intToBytes = (value: bigint): Uint8Array => Uint8Array.from(Buffer.from(value.toString(16).padStart(64, '0'), 'hex'))

function pow (base: bigint, exponent: bigint, m: bigint): bigint {
  let result = 1n
  for (let b = mod(base, m), e = exponent; e > 0n; e >>= 1n, b = (b * b) % m) if ((e & 1n) === 1n) result = (result * b) % m
  return result
}
const inv = (a: bigint, m: bigint): bigint => pow(a, m - 2n, m)

function add (p: Point, q: Point): Point {
  if (p === null) return q
  if (q === null) return p
  if (p.x === q.x && mod(p.y + q.y, P) === 0n) return null
  const slope = p.x === q.x ? mod(3n * p.x * p.x * inv(2n * p.y, P), P) : mod((q.y - p.y) * inv(q.x - p.x, P), P)
  const x = mod(slope * slope - p.x - q.x, P)
  return { x, y: mod(slope * (p.x - x) - p.y, P) }
}

function multiply (k: bigint, point: Point): Point {
  let result: Point = null
  for (let addend = point, e = k; e > 0n; e >>= 1n, addend = add(addend, addend)) if ((e & 1n) === 1n) result = add(result, addend)
  return result
}

const hmac = (key: Uint8Array, ...parts: Uint8Array[]): Uint8Array => new Uint8Array(createHmac('sha256', key).update(concat(...parts)).digest())

/** RFC 6979 section 3.2 with HMAC-SHA-256, the nonce a wallet uses. */
function nonce (priv: Uint8Array, digest: Uint8Array): bigint {
  const h1 = intToBytes(bytesToInt(digest) % N)
  let v: Uint8Array = new Uint8Array(32).fill(1)
  let k: Uint8Array = new Uint8Array(32)
  k = hmac(k, v, Uint8Array.of(0), priv, h1)
  v = hmac(k, v)
  k = hmac(k, v, Uint8Array.of(1), priv, h1)
  v = hmac(k, v)
  for (;;) {
    v = hmac(k, v)
    const candidate = bytesToInt(v)
    if (candidate >= 1n && candidate < N) return candidate
    k = hmac(k, v, Uint8Array.of(0))
    v = hmac(k, v)
  }
}

const addressOfPoint = (point: NonNullable<Point>): string => toChecksumAddress('0x' + toHex(keccak256(concat(intToBytes(point.x), intToBytes(point.y))).slice(12)))

export function addressOf (priv: Uint8Array): string {
  return addressOfPoint(multiply(bytesToInt(priv), G) as NonNullable<Point>)
}

/** r, s (the low one), then v as 27 or 28: what `signMessage` gives. */
export function signDigest (priv: Uint8Array, digest: Uint8Array): Uint8Array {
  const d = bytesToInt(priv)
  const k = nonce(priv, digest)
  const point = multiply(k, G) as NonNullable<Point>
  const r = mod(point.x, N)
  let s = mod(inv(k, N) * (bytesToInt(digest) + r * d), N)
  let parity = Number(point.y & 1n)
  if (s > N / 2n) {
    s = N - s
    parity ^= 1
  }
  return concat(intToBytes(r), intToBytes(s), Uint8Array.of(27 + parity))
}

/** The address that made `signature` (r, s, v 27 or 28) over `digest`, or null. */
export function recoverAddress (digest: Uint8Array, signature: Uint8Array): string | null {
  const r = bytesToInt(signature.subarray(0, 32))
  const s = bytesToInt(signature.subarray(32, 64))
  const v = signature[64] ?? 0
  if (r < 1n || r >= N || s < 1n || s >= N || (v !== 27 && v !== 28)) return null
  const target = mod(r ** 3n + 7n, P)
  let y = pow(target, (P + 1n) / 4n, P)
  if (mod(y * y, P) !== target) return null
  if (Number(y & 1n) !== v - 27) y = P - y
  const rInverse = inv(r, N)
  const sR = multiply(s, { x: r, y })
  const zG = multiply(mod(-bytesToInt(digest), N), G)
  const point = multiply(rInverse, add(sR, zG))
  return point === null ? null : addressOfPoint(point)
}

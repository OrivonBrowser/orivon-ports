// A stand-in for the page's `orivon.id` that does what the broker does (src/broker/policy/derive-p256.ts): P-256 only,
// a 65-byte uncompressed public key, a 64-byte r||s ECDSA signature over SHA-256 of the payload as given. WebCrypto
// does the signing, as it does in the broker, so a signature here is the real format and not a transcription of it.

export interface FakeId {
  id: {
    publicKey: (options: { curve: string }) => Promise<Uint8Array>
    sign: (options: { curve: string, payload: Uint8Array }) => Promise<Uint8Array>
  }
  signed: Uint8Array[]
}

function refuseCurve (curve: string): never {
  throw Object.assign(new Error(curve === 'secp256k1' ? 'no signing for secp256k1 in the policy layer -- P-256 only' : `unsupported curve: ${curve}`), { code: curve === 'secp256k1' ? 'internal' : 'invalid' })
}

export async function fakeId (): Promise<FakeId> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const signed: Uint8Array[] = []
  return {
    signed,
    id: {
      publicKey: async ({ curve }) => {
        if (curve !== 'P-256') refuseCurve(curve)
        return publicKey.slice()
      },
      sign: async ({ curve, payload }) => {
        if (curve !== 'P-256') refuseCurve(curve)
        signed.push(payload.slice())
        return new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, payload))
      }
    }
  }
}

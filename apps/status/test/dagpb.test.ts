import { describe, expect, it } from 'vitest'
import { fromHex } from '../site/bytes.js'
import { cidToString, CODEC, parseCidBytes } from '../site/cid.js'
import { decodeDagPb, decodeUnixfs } from '../site/dagpb.js'

// The root folder of a real release (five packages), as an IPFS node returns it.
const RELEASE_ROOT = '12430a240170122078a4cadf8bc92a88fa39599ceb81fc29f967b75a18b96d19db1ba7e43b564edf12164f7269766f6e2d302e302e382d61726d36342e646d6718a5e9fc4d12410a2401701220d61ca78950c010d2d713b588553549be8ce26ddaa4341530acb809fefb0154c112144f7269766f6e2d302e302e382d7836342e646d6718c9e69d5112490a2401701220b1b6d0c804f582b88a21930b5f1c66eb437ebfe60a18316aa9e473ae697891f6121c4f7269766f6e2d302e302e382d7838365f36342e417070496d61676518c9b7934d12470a24017012205b7e87d2267a89363d5c272c3f629c30aebe9e843e1bacc8e882443db1c5d9ea121a4f7269766f6e2d53657475702d302e302e382d7836342e6578651894d1984112430a2401701220919e8f342ab7ad3d3fdd4ff831ddda07f37d6a5e5d21a88e866a264d84e819f012166f7269766f6e5f302e302e385f616d6436342e64656218c781d93b0a020801'

// The root block of one file in that folder (the .deb): three links to the file's chunks.
const FILE_ROOT = '122d0a2401701220bcec8bc0bcf937f89e994d10b05caa87f3de0bd20d6840bafc86fc95880b3a3d12001886c4e015122d0a24017012204b888ef877824d458aad0ba9a5ee05e33f0c683417455e947029905d34a6ee5512001886c4e015122d0a24017012208800718b39bfd6d8e016b8f5ec1acd0f4b0503f504ee4b4d78f78085bbcd5ba712001896f897100a16080218a8c5d73b208080e015208080e01520a8c59710'

describe('dag-pb folder', () => {
  const node = decodeDagPb(fromHex(RELEASE_ROOT))

  it('lists the five packages with their names, sizes and addresses', () => {
    expect(node.links.map((link) => link.name)).toEqual([
      'Orivon-0.0.8-arm64.dmg',
      'Orivon-0.0.8-x64.dmg',
      'Orivon-0.0.8-x86_64.AppImage',
      'Orivon-Setup-0.0.8-x64.exe',
      'orivon_0.0.8_amd64.deb'
    ])
    expect(node.links[4]?.tsize).toBe(125190343)
    expect(cidToString(parseCidBytes(node.links[4]!.hash))).toBe('bafybeiert2htikvxvu6t7xkp7ay53wqh6n6wuxs5egui5btkezgyj2az6a')
  })

  it('reads the UnixFS record as a directory', () => {
    expect(decodeUnixfs(node.data!)).toMatchObject({ type: 1, typeName: 'directory', filesize: null, blocksizes: [] })
  })
})

describe('dag-pb file', () => {
  const node = decodeDagPb(fromHex(FILE_ROOT))
  const unixfs = decodeUnixfs(node.data!)

  it('reads a file whose size is the sum of its chunks', () => {
    expect(unixfs.typeName).toBe('file')
    expect(unixfs.filesize).toBe(125166248)
    expect(unixfs.blocksizes.length).toBe(node.links.length)
    expect(unixfs.blocksizes.reduce((a, b) => a + b, 0)).toBe(unixfs.filesize)
  })

  it('has unnamed dag-pb links to the chunks', () => {
    expect(node.links.length).toBe(3)
    for (const link of node.links) {
      expect(link.name).toBe('')
      expect(parseCidBytes(link.hash).codec).toBe(CODEC.dagPb)
    }
  })
})

describe('malformed input', () => {
  it('refuses a truncated field', () => {
    expect(() => decodeDagPb(fromHex(RELEASE_ROOT).slice(0, 40))).toThrow()
  })

  it('names a UnixFS type it knows, and one it does not', () => {
    expect(decodeUnixfs(Uint8Array.from([0x08, 0x05])).typeName).toBe('sharded folder')
    expect(decodeUnixfs(Uint8Array.from([0x08, 0x09])).typeName).toBe('type 9')
  })
})

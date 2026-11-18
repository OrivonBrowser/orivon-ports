// The gateway: content types from names and bytes, byte ranges, the IPNS record, and what it refuses.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { contentType, parseRange } from '../kubo/gateway.js'
import { API, createEnv, lines } from './support/env.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])

let env: Awaited<ReturnType<typeof createEnv>>
beforeEach(async () => { env = await createEnv() })
afterEach(async () => { await env.cleanup() })

const get = (path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Response> => env.facade.handle(new Request(`${API}${path}`, { method, headers }))

async function addWrapped (name: string, body: Uint8Array | string): Promise<{ file: string, directory: string }> {
  const out = await lines<{ Name: string, Hash: string }>(await env.call('add', { body, filename: name, query: { 'wrap-with-directory': true, 'cid-version': 1 } }))
  return { file: out.find((one) => one.Name === name)?.Hash ?? '', directory: out.find((one) => one.Name === '')?.Hash ?? '' }
}

describe('contentType', () => {
  it('takes the extension first, then the first bytes, and falls back to a type a browser will not run', () => {
    expect(contentType('x.PNG', new Uint8Array(0))).toBe('image/png')
    expect(contentType('movie.webm', new Uint8Array(0))).toBe('video/webm')
    expect(contentType('page.html', new Uint8Array(0))).toBe('text/plain; charset=utf-8')
    expect(contentType('', PNG)).toBe('image/png')
    expect(contentType('noext', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(contentType('', new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]))).toBe('video/mp4')
    expect(contentType('', new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(contentType('', new TextEncoder().encode('<script>alert(1)</script>'))).toBe('application/octet-stream')
  })
})

describe('parseRange', () => {
  it('reads one byte range against the size', () => {
    expect(parseRange('bytes=2-5', 16)).toEqual({ start: 2, end: 5 })
    expect(parseRange('bytes=4-', 16)).toEqual({ start: 4, end: 15 })
    expect(parseRange('bytes=-4', 16)).toEqual({ start: 12, end: 15 })
    expect(parseRange('bytes=10-99', 16)).toEqual({ start: 10, end: 15 })
    expect(parseRange('bytes=16-', 16)).toBe('unsatisfiable')
    expect(parseRange('bytes=5-2', 16)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-1,4-5', 16)).toBeNull()
    expect(parseRange(null, 16)).toBeNull()
  })
})

describe('/ipfs', () => {
  it('serves a file by path with its type from the name, marked nosniff and sandboxed', async () => {
    const { directory, file } = await addWrapped('pic.png', PNG)
    const response = await get(`/ipfs/${directory}/pic.png`)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-length')).toBe('16')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe('sandbox')
    expect(response.headers.get('etag')).toBe(`"${file}"`)
  })

  it('sniffs the type of a file with no name, and serves unknown bytes as octet-stream', async () => {
    const { file } = await addWrapped('x', PNG)
    expect((await get(`/ipfs/${file}`)).headers.get('content-type')).toBe('image/png')
    const text = await addWrapped('y', 'just text')
    expect((await get(`/ipfs/${text.file}`)).headers.get('content-type')).toBe('application/octet-stream')
    expect((await get(`/ipfs/${text.file}?filename=note.txt`)).headers.get('content-type')).toBe('text/plain; charset=utf-8')
  })

  it('answers byte ranges with 206 and the Content-Range, and 416 past the end', async () => {
    const { file } = await addWrapped('pic.png', PNG)
    const ranged = await get(`/ipfs/${file}`, { range: 'bytes=2-5' })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 2-5/16')
    expect(ranged.headers.get('content-length')).toBe('4')
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(PNG.subarray(2, 6))
    const suffix = await get(`/ipfs/${file}`, { range: 'bytes=-4' })
    expect(suffix.headers.get('content-range')).toBe('bytes 12-15/16')
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(PNG.subarray(12))
    const open = await get(`/ipfs/${file}`, { range: 'bytes=10-' })
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(PNG.subarray(10))
    const past = await get(`/ipfs/${file}`, { range: 'bytes=99-' })
    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe('bytes */16')
  })

  it('answers HEAD with the headers and no body', async () => {
    const { file } = await addWrapped('pic.png', PNG)
    const response = await get(`/ipfs/${file}`, {}, 'HEAD')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('16')
    expect(await response.text()).toBe('')
  })

  it('refuses a directory, a missing path, a bad CID and a method that is not GET or HEAD', async () => {
    const { directory } = await addWrapped('pic.png', PNG)
    expect((await get(`/ipfs/${directory}`)).status).toBe(404)
    expect((await get(`/ipfs/${directory}/missing.png`)).status).toBe(404)
    expect((await get('/ipfs/not-a-cid')).status).toBe(400)
    expect((await get('/elsewhere')).status).toBe(404)
    expect((await get(`/ipfs/${directory}/pic.png`, {}, 'POST')).status).toBe(405)
  })
})

describe('/ipns', () => {
  it('follows a name to its file when no record is asked for', async () => {
    const { directory } = await addWrapped('pic.png', PNG)
    const { Id } = await env.json<{ Id: string }>('key/gen', { args: ['k'], query: { 'ipns-base': 'b58mh' } })
    await env.call('name/publish', { args: [`/ipfs/${directory}`], query: { key: 'k' } })
    const response = await get(`/ipns/${Id}/pic.png`)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
  })

  it('passes the record through, with the Accept header it was asked with, and 404s for none', async () => {
    const { Id } = await env.json<{ Id: string }>('key/gen', { args: ['k'], query: { 'ipns-base': 'b58mh' } })
    await env.call('name/publish', { args: ['/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'], query: { key: 'k' } })
    const response = await get(`/ipns/${Id}?format=ipns-record`, { accept: 'application/vnd.ipfs.ipns-record' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/vnd.ipfs.ipns-record')
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0)
    expect((await get('/ipns/12D3KooWNoSuchName?format=ipns-record')).status).toBe(404)
  })
})

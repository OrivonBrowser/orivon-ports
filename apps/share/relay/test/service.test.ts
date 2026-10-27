import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { tcp } from '@libp2p/tcp'
import { createLibp2p } from 'libp2p'

const ENTRY = fileURLToPath(new URL('../relay.mjs', import.meta.url))

interface Service { child: ChildProcess, lines: string[], address: Promise<string>, exited: Promise<number | null> }

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

/** The service as systemd runs it: its own process, its settings in the environment. */
function startService (stateDir: string): Service {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, STATE_DIR: stateDir, LISTEN: '/ip4/127.0.0.1/tcp/0', ANNOUNCE: '', LOG_EVERY_MS: '200' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  cleanups.push(async () => { child.kill('SIGKILL') })
  const lines: string[] = []
  let started: (address: string) => void = () => undefined
  const address = new Promise<string>((resolve) => { started = resolve })
  for (const channel of [child.stdout, child.stderr]) {
    let pending = ''
    channel.setEncoding('utf8')
    channel.on('data', (text: string) => {
      const parts = (pending + text).split('\n')
      pending = parts.pop() ?? ''
      for (const line of parts) {
        lines.push(line)
        const match = /^share-relay started: (\S+)/.exec(line)
        if (match?.[1] != null) started(match[1])
      }
    })
  }
  const exited = new Promise<number | null>((resolve) => { child.on('exit', (code) => { resolve(code) }) })
  return { child, lines, address, exited }
}

async function until (condition: () => boolean, ms = 15_000): Promise<void> {
  const limit = Date.now() + ms
  while (!condition()) {
    if (Date.now() > limit) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('the service', () => {
  it('keeps its peer ID across a restart, and its key file private', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'share-relay-service-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))

    const first = startService(dir)
    const firstAddress = await first.address
    first.child.kill('SIGTERM')
    expect(await first.exited).toBe(0)

    const second = startService(dir)
    const secondAddress = await second.address
    second.child.kill('SIGTERM')
    expect(await second.exited).toBe(0)

    const id = (address: string): string | undefined => /\/p2p\/(\w+)$/.exec(address)?.[1]
    expect(id(firstAddress)).toBeDefined()
    expect(id(secondAddress)).toBe(id(firstAddress))
    expect((await stat(join(dir, 'peer-key.pb'))).mode & 0o777).toBe(0o600)
  }, 30_000)

  it('logs counters on a timer, and no address of anyone who connected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'share-relay-service-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const service = startService(dir)
    const address = await service.address

    const peer = await createLibp2p({
      addresses: { listen: [`${address}/p2p-circuit`] },
      transports: [tcp(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() }
    })
    cleanups.push(() => peer.stop())

    await until(() => service.lines.some((line) => /^share-relay stats: reservations=1 connections=1 /.test(line)))
    await peer.stop()
    await until(() => service.lines.some((line) => /^share-relay stats: reservations=\d+ connections=0 /.test(line)))
    service.child.kill('SIGTERM')
    await service.exited

    const afterStart = service.lines.filter((line) => !line.startsWith('share-relay started:'))
    expect(afterStart.length).toBeGreaterThan(1)
    for (const line of afterStart) {
      expect(line).toMatch(/^share-relay stats: reservations=\d+ connections=\d+ circuits_since_last=\d+ bytes_since_last=\d+ circuits_total=\d+ bytes_total=\d+$/)
    }
  }, 40_000)
})

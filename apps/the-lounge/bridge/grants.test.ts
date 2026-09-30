// What orivon.json grants for IRC, read as orivon-mvp's broker reads it: a port it reserves (IRC's
// 6667 and 6697) is authorised only by a pattern that names the host and that exact port, so
// `*:*` and every range skip them. Plain IRC is a `tcp` dial and TLS IRC an `https` one.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../orivon.json', import.meta.url), 'utf8')) as {
  capabilities: { net: { tcp: { connect: string[] }, https: { connect: string[] } } }
}
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]']
const RESERVED = { tcp: '6667', https: '6697' } as const
/** Upstream's default network (defaults/config.js), which a first connection uses as offered. */
const DEFAULT_NETWORK = 'irc.libera.chat'

const isLoopback = (pattern: string): boolean => LOOPBACK.some((host) => pattern.startsWith(`${host}:`))
const namedHosts = (scope: 'tcp' | 'https'): string[] => manifest.capabilities.net[scope].connect
  .filter((pattern) => pattern !== '*:*' && !isLoopback(pattern))

describe('the IRC grants', () => {
  for (const scope of ['tcp', 'https'] as const) {
    const patterns = manifest.capabilities.net[scope].connect

    it(`${scope}.connect covers IRC's customary ports on each loopback host, the reserved two by name`, () => {
      for (const host of LOOPBACK) {
        expect(patterns, host).toContain(`${host}:6660-6699`)
        expect(patterns, host).toContain(`${host}:6667`)
        expect(patterns, host).toContain(`${host}:6697`)
      }
      expect(patterns.filter(isLoopback)).toHaveLength(LOOPBACK.length * 3)
    })

    it(`${scope}.connect names upstream's default network at ${RESERVED[scope]}`, () => {
      expect(patterns).toContain(`${DEFAULT_NETWORK}:${RESERVED[scope]}`)
    })

    it(`${scope}.connect names each network by its host and exactly ${RESERVED[scope]}, never a wildcard or a range`, () => {
      const named = namedHosts(scope)
      expect(named.length).toBeGreaterThan(1)
      for (const pattern of named) {
        expect(pattern, pattern).toMatch(new RegExp(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+:${RESERVED[scope]}$`))
      }
      expect(new Set(named).size).toBe(named.length)
    })
  }

  it('names the same networks for plain and TLS IRC', () => {
    const hosts = (scope: 'tcp' | 'https'): string[] => namedHosts(scope).map((pattern) => pattern.slice(0, pattern.lastIndexOf(':')))
    expect(hosts('tcp')).toEqual(hosts('https'))
  })
})

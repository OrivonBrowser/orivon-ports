// What orivon.json grants for IRC, read as orivon-mvp's broker reads it: a port it reserves (IRC's
// 6667 and 6697) is reached only by a pattern that names that exact port, so `*:*` and every range
// skip them, and `*:6667`/`*:6697` are what reach any network there. `*` never reaches loopback, so
// a local bouncer has entries of its own. Plain IRC is a `tcp` dial and TLS IRC an `https` one.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../orivon.json', import.meta.url), 'utf8')) as {
  capabilities: { net: { tcp: { connect: string[] }, https: { connect: string[] } } }
}
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]']
const RESERVED = ['6667', '6697']

const isLoopback = (pattern: string): boolean => LOOPBACK.some((host) => pattern.startsWith(`${host}:`))

describe('the IRC grants', () => {
  for (const scope of ['tcp', 'https'] as const) {
    const patterns = manifest.capabilities.net[scope].connect

    it(`${scope}.connect reaches any public host on any port, IRC's reserved two by name`, () => {
      expect(patterns).toContain('*:*')
      for (const port of RESERVED) expect(patterns).toContain(`*:${port}`)
    })

    it(`${scope}.connect covers IRC's customary ports on each loopback host, the reserved two by name`, () => {
      for (const host of LOOPBACK) {
        expect(patterns, host).toContain(`${host}:6660-6699`)
        for (const port of RESERVED) expect(patterns, host).toContain(`${host}:${port}`)
      }
    })

    it(`${scope}.connect names no other host`, () => {
      const rest = patterns.filter((pattern) => !pattern.startsWith('*:') && !isLoopback(pattern))
      expect(rest).toEqual([])
      expect(patterns).toHaveLength(3 + LOOPBACK.length * 3)
    })
  }
})

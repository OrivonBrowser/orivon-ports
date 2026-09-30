// What orivon.json grants to loopback, read as orivon-mvp's broker reads it: a port it reserves
// (IRC's 6667 and 6697) is authorised only by a pattern that names it exactly, so a range alone
// would leave the two commonest IRC ports refused.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../orivon.json', import.meta.url), 'utf8')) as {
  capabilities: { net: { tcp: { connect: string[] }, https: { connect: string[] } } }
}
const HOSTS = ['127.0.0.1', 'localhost', '[::1]']

describe('the loopback grants', () => {
  for (const scope of ['tcp', 'https'] as const) {
    const patterns = manifest.capabilities.net[scope].connect

    it(`${scope}.connect covers IRC's customary ports on each loopback host, the reserved two by name`, () => {
      for (const host of HOSTS) {
        expect(patterns, host).toContain(`${host}:6660-6699`)
        expect(patterns, host).toContain(`${host}:6667`)
        expect(patterns, host).toContain(`${host}:6697`)
      }
    })

    it(`${scope}.connect grants loopback nowhere else`, () => {
      const loopback = patterns.filter((pattern) => pattern !== '*:*')
      expect(loopback).toHaveLength(HOSTS.length * 3)
      for (const pattern of loopback) expect(HOSTS.some((host) => pattern.startsWith(`${host}:`)), pattern).toBe(true)
    })
  }
})

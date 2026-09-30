// The two modules that stand in for dependencies this port leaves out: every
// member throws, by name, with the reason.
import { describe, expect, it } from 'vitest'
import * as undici from './refused-undici.js'
import devServer from './refused-dev-server.js'
import { refusal, refusing } from './refusal.js'

describe('refusal', () => {
  it('is named, coded and says what and why', () => {
    const error = refusal('x.y', 'because')
    expect(error.name).toBe('OrivonPortRefusal')
    expect(error.code).toBe('ORIVON_PORT_REFUSED')
    expect(error.message).toBe('x.y is refused by the Orivon port of The Lounge: because')
  })

  it('throws only when called, never when read, so feature detection is safe', () => {
    const fn = refusing('a', 'b')
    expect(typeof fn).toBe('function')
    expect(() => fn()).toThrow(/OrivonPortRefusal|refused/)
  })
})

describe('the undici stand-in', () => {
  const members = Object.entries(undici).filter(([name]) => name !== 'default')

  it('exports the entry points cheerio and undici\'s own API name, and every one throws by name', () => {
    expect(members.map(([name]) => name).sort()).toEqual(['Agent', 'Client', 'Pool', 'connect', 'fetch', 'pipeline', 'request', 'stream', 'upgrade'])
    for (const [name, member] of members) {
      expect(() => (member as () => void)(), name).toThrow(`undici.${name} is refused`)
    }
  })

  it('carries the same members on its default export', () => {
    expect(Object.keys(undici.default).sort()).toEqual(members.map(([name]) => name).sort())
  })
})

describe('the dev-server stand-in', () => {
  it('rejects, naming the flag, instead of starting a bundler', async () => {
    await expect(devServer()).rejects.toMatchObject({ name: 'OrivonPortRefusal', message: expect.stringContaining('--dev') })
  })
})

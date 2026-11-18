// The relay a person names: what is accepted, what is kept across a restart, what saving it does to the node, and what removing it leaves.
import * as realFs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../worker/board-config.js'
import { relaySetting, UnsupportedError } from '../worker/relay-setting.js'

const RELAY = '/ip4/145.40.68.4/tcp/4001/p2p/12D3KooWRelayRelay'
const OTHER = '/dns4/relay.example.org/tcp/443/p2p/12D3KooWOtherRelay'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bitsocial-relay-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function make (over: { fromConfig?: string, supported?: boolean, isolated?: boolean } = {}) {
  const restart = vi.fn(async () => {})
  const setting = relaySetting({ file: join(dir, 'relay.json'), fs: realFs as never, supported: () => over.supported ?? true, restart, ...(over.fromConfig === undefined ? {} : { fromConfig: over.fromConfig }), ...(over.isolated === undefined ? {} : { isolated: over.isolated }) })
  return { setting, restart }
}

describe('the relay setting, validation', () => {
  it.each([
    ['not an address', 'relay.example'], ['no peer id', '/ip4/145.40.68.4/tcp/4001'], ['not text', 7], ['empty', ''],
    ['on this computer', '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWRelayRelay'], ['on the home network', '/ip4/192.168.1.2/tcp/4001/p2p/12D3KooWRelayRelay'], ['called localhost', '/dns4/localhost/tcp/4001/p2p/12D3KooWRelayRelay'],
    ['a documentation address, which the node refuses', '/ip4/203.0.113.7/tcp/4001/p2p/12D3KooWRelayRelay'], ['in the shared address space', '/ip4/100.64.0.1/tcp/4001/p2p/12D3KooWRelayRelay']
  ])('refuses a relay that is %s, as a request that is wrong (400), and starts nothing', async (_why, address) => {
    const { setting, restart } = make()
    expect(() => setting.set(address)).toThrow(ConfigError)
    expect(restart).not.toHaveBeenCalled()
    expect(setting.current().relay).toBeUndefined()
  })

  it('takes an address on loopback only for a run with no internet', async () => {
    const { setting } = make({ isolated: true })
    await setting.set('/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWRelayRelay')
    expect(setting.current().relay).toBe('/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWRelayRelay')
  })

  it('refuses to save a relay for a node component that has no --relay, as a conflict (409)', async () => {
    const { setting, restart } = make({ supported: false })
    await expect(setting.set(RELAY)).rejects.toBeInstanceOf(UnsupportedError)
    await expect(setting.clear()).rejects.toBeInstanceOf(UnsupportedError)
    expect(restart).not.toHaveBeenCalled()
  })
})

describe('the relay setting, saving', () => {
  it.each([RELAY, OTHER, '/ip6/2001:db8::7/tcp/4001/p2p/12D3KooWRelayRelay'])('saves %s, starts the node again once and says the setting is the person\'s', async (address) => {
    const { setting, restart } = make()
    expect(await setting.set(address)).toEqual({ relay: address, source: 'saved' })
    expect(restart).toHaveBeenCalledTimes(1)
    expect(JSON.parse(realFs.readFileSync(join(dir, 'relay.json'), 'utf-8'))).toEqual({ relay: address })
  })

  it('does not start the node again for the relay it already has', async () => {
    const { setting, restart } = make()
    await setting.set(RELAY)
    await setting.set(RELAY)
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('is read again by the next Worker: what was saved holds after a restart', async () => {
    await make().setting.set(RELAY)
    const next = make()
    expect(next.setting.current()).toEqual({ relay: RELAY, source: 'saved' })
    expect(next.restart).not.toHaveBeenCalled()
  })

  it('replaces one relay with another and starts the node again for it', async () => {
    const { setting, restart } = make()
    await setting.set(RELAY)
    await setting.set(OTHER)
    expect(setting.current().relay).toBe(OTHER)
    expect(restart).toHaveBeenCalledTimes(2)
  })
})

describe('the relay setting, removing', () => {
  it('leaves the node with none, even when the page\'s configuration named one, and keeps it removed after a restart', async () => {
    const { setting, restart } = make({ fromConfig: RELAY })
    expect(setting.current()).toEqual({ relay: RELAY, source: 'page' })
    expect(await setting.clear()).toEqual({ relay: undefined, source: 'none' })
    expect(restart).toHaveBeenCalledTimes(1)
    expect(make({ fromConfig: RELAY }).setting.current()).toEqual({ relay: undefined, source: 'none' })
  })

  it('asks for no restart when there was no relay to remove', async () => {
    const { setting, restart } = make()
    await setting.clear()
    expect(restart).not.toHaveBeenCalled()
  })

  it('has the saved relay take the place of the page\'s, and falls back to the page\'s when nothing is saved', async () => {
    const { setting } = make({ fromConfig: RELAY })
    await setting.set(OTHER)
    expect(setting.current()).toEqual({ relay: OTHER, source: 'saved' })
    expect(make().setting.current().source).toBe('saved')
  })

  it('reads a damaged or foreign file as nothing saved', () => {
    realFs.writeFileSync(join(dir, 'relay.json'), '{ not json')
    expect(make({ fromConfig: RELAY }).setting.current()).toEqual({ relay: RELAY, source: 'page' })
    realFs.writeFileSync(join(dir, 'relay.json'), JSON.stringify({ relay: 'relay.example' }))
    expect(make().setting.current()).toEqual({ relay: undefined, source: 'none' })
  })

  it('does not start the node with a relay a node would refuse, one saved before the check knew the rule', () => {
    realFs.writeFileSync(join(dir, 'relay.json'), JSON.stringify({ relay: '/ip4/203.0.113.7/tcp/4001/p2p/12D3KooWRelayRelay' }))
    expect(make({ fromConfig: RELAY }).setting.current()).toEqual({ relay: RELAY, source: 'page' })
    expect(make().setting.current()).toEqual({ relay: undefined, source: 'none' })
  })
})

// What the page forks the Worker with, and the checks that refuse a bad value before anything starts.
import { describe, expect, it } from 'vitest'
import { CONFIG_VARIABLE, checkRelay, layout, readConfig } from '../worker/config.js'
import { NODE_REQUESTS, nodeArgs } from '../worker/run.js'

const good = { authKey: 'k'.repeat(32), files: '/orivon/app/bitsocial/', ports: { rpc: 9138, gateway: 6473, kubo: 50019, nodeApi: 5351, p2p: 4851 }, origins: ['http://127.0.0.1:8953'], trace: 'warn' }
const env = (value: unknown): Record<string, string> => ({ [CONFIG_VARIABLE]: typeof value === 'string' ? value : JSON.stringify(value) })

describe('readConfig', () => {
  it('reads what the page sent and trims the files directory', () => {
    expect(readConfig(env(good))).toEqual({ ...good, files: '/orivon/app/bitsocial' })
  })

  it('defaults the origins to none and the trace to warnings', () => {
    const { origins, trace, ...bare } = good
    expect(origins).toHaveLength(1)
    expect(trace).toBe('warn')
    expect(readConfig(env(bare))).toMatchObject({ origins: [], trace: 'warn' })
  })

  it.each([
    ['no variable', {}, /is not set/],
    ['not JSON', env('{'), /is not JSON/],
    ['a short key', env({ ...good, authKey: 'short' }), /authKey/],
    ['a key with a slash', env({ ...good, authKey: 'a/b'.repeat(8) }), /authKey/],
    ['a relative directory', env({ ...good, files: 'bitsocial' }), /files/],
    ['a privileged port', env({ ...good, ports: { ...good.ports, rpc: 80 } }), /ports\.rpc/],
    ['a missing port', env({ ...good, ports: { rpc: 9138 } }), /ports\.gateway/],
    ['two services on one port', env({ ...good, ports: { ...good.ports, p2p: 5351 } }), /differ/],
    ['an origin that is not text', env({ ...good, origins: [1] }), /origins/],
    ['a trace that is a command', env({ ...good, trace: 'warn; rm -rf /' }), /trace/],
    ['log namespaces that are a command', env({ ...good, debug: 'pkc*; rm -rf /' }), /debug/],
    ['log namespaces that are not text', env({ ...good, debug: 7 }), /debug/],
    ['an isolated run with no peer', env({ ...good, isolated: { bootstrap: [] } }), /isolated/],
    ['an isolated run that dials the internet', env({ ...good, isolated: { bootstrap: ['/ip4/8.8.8.8/tcp/4001/p2p/12D3KooWAbCdEfGhIj'] } }), /isolated/],
    ['a relay that is not an address', env({ ...good, relay: 'relay.example' }), /relay must be \//],
    ['a relay with no peer id', env({ ...good, relay: '/ip4/145.40.68.4/tcp/4001' }), /relay must be \//],
    ['a relay that is not text', env({ ...good, relay: 7 }), /relay must be \//],
    ['a relay on loopback', env({ ...good, relay: '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWRelayRelay' }), /internet/],
    ['a relay on the home network', env({ ...good, relay: '/ip4/192.168.1.2/tcp/4001/p2p/12D3KooWRelayRelay' }), /internet/],
    ['a relay called localhost', env({ ...good, relay: '/dns4/localhost/tcp/4001/p2p/12D3KooWRelayRelay' }), /internet/]
  ])('refuses %s', (_name, given, message) => {
    expect(() => readConfig(given as Record<string, string>)).toThrow(message)
  })
})

describe('readConfig, more of pkc-js\'s log', () => {
  it('keeps the namespaces the page named, and has none otherwise', () => {
    expect(readConfig(env({ ...good, debug: 'pkc-js:local-community:*,-*:trace' })).debug).toBe('pkc-js:local-community:*,-*:trace')
    expect(readConfig(env(good))).not.toHaveProperty('debug')
  })
})

describe('readConfig, a relay the person names', () => {
  it.each(['/ip4/145.40.68.4/tcp/4001/p2p/12D3KooWRelayRelay', '/dns4/relay.example.org/tcp/443/p2p/12D3KooWRelayRelay', '/ip6/2001:db8::7/tcp/4001/p2p/12D3KooWRelayRelay'])('keeps %s', (relay) => {
    expect(readConfig(env({ ...good, relay })).relay).toBe(relay)
  })

  it('has none unless one is named: Orivon names no relay of its own', () => {
    expect(readConfig(env(good))).not.toHaveProperty('relay')
  })

  it('lets an isolated run name a relay on loopback, where the node is told to dial the local network', () => {
    const peer = '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAbCdEfGhIjKlMn'
    expect(readConfig(env({ ...good, relay: peer, isolated: { bootstrap: [peer] } })).relay).toBe(peer)
  })
})

describe('layout', () => {
  it('keeps the data, the node database and its key secret, the facade state, the board manager\'s folder, seeding\'s and the relay setting apart under the files directory', () => {
    expect(layout('/orivon/app/bitsocial')).toEqual({ data: '/orivon/app/bitsocial/pkc', nodeDb: '/orivon/app/bitsocial/node/blocks.db', keySecret: '/orivon/app/bitsocial/node/keys.secret', facadeState: '/orivon/app/bitsocial/facade/state.json', boardManager: '/orivon/app/bitsocial/board-manager', seeding: '/orivon/app/bitsocial/seeding', relay: '/orivon/app/bitsocial/relay.json' })
  })
})

describe('readConfig, isolated', () => {
  const peer = '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAbCdEfGhIjKlMn'
  it('keeps the loopback peers of an isolated run', () => {
    expect(readConfig(env({ ...good, isolated: { bootstrap: [peer] } })).isolated).toEqual({ bootstrap: [peer] })
    expect(readConfig(env(good))).not.toHaveProperty('isolated')
  })
})

describe('nodeArgs', () => {
  const config = readConfig(env(good))
  const base = { config, key: 'a'.repeat(64), nodeDb: '/db/blocks.db' }

  it('starts the node in serve mode on the app\'s ports, with the key, and with no flag the component might not know', () => {
    const args = nodeArgs({ ...base, flags: [] })
    expect(args).toEqual(['--online', '--routing-mode', 'auto', '--db', '/db/blocks.db', '--serve', '--api-key', 'a'.repeat(64), '--addr', '127.0.0.1:5351', '--p2p-port', '4851', '--trace-filter', 'warn', '--max-concurrent-requests', '64'])
  })

  it('lets the node serve 64 requests at once, so reads that wait on the network never leave a call that does not (the node\'s own 8 would answer it 503 "gateway busy" after 2 s)', () => {
    for (const flags of [[], ['--publish', '--key-secret', '--punch-port']]) {
      const args = nodeArgs({ ...base, flags, secret: 'b'.repeat(64) })
      expect(args.slice(args.indexOf('--max-concurrent-requests'), args.indexOf('--max-concurrent-requests') + 2)).toEqual(['--max-concurrent-requests', String(NODE_REQUESTS)])
    }
    expect(NODE_REQUESTS).toBeGreaterThan(8)
  })

  it('adds publish and the HTTP routers only for a component that has them', () => {
    const args = nodeArgs({ ...base, flags: ['--publish', '--http-router'] })
    expect(args).toContain('--publish')
    expect(args).toContain('--keys-in-memory')
    expect(args.filter((arg) => arg === '--http-router')).toHaveLength(4)
    expect(args[args.indexOf('--http-router') + 1]).toBe('https://routing.lol')
  })

  it('seals the keys under the secret and raises the key cap, for a component that takes both', () => {
    const secret = 'b'.repeat(64)
    const args = nodeArgs({ ...base, flags: ['--publish', '--key-secret', '--max-ipns-keys'], secret })
    expect(args.slice(args.indexOf('--publish'), args.indexOf('--publish') + 5)).toEqual(['--publish', '--key-secret', secret, '--max-ipns-keys', '64'])
    expect(args).not.toContain('--keys-in-memory')
    expect(() => nodeArgs({ ...base, flags: ['--publish', '--key-secret'] })).toThrow(/secret/)
  })

  const punching = ['--publish', '--key-secret', '--punch-port'] as const

  it('punches in place of listening when the component can and the run is not isolated: the one port, and never both flags', () => {
    const args = nodeArgs({ ...base, flags: [...punching], secret: 'b'.repeat(64) })
    expect(args.slice(args.indexOf('--addr'), args.indexOf('--addr') + 4)).toEqual(['--addr', '127.0.0.1:5351', '--punch-port', '4851'])
    expect(args).not.toContain('--p2p-port')
    expect(nodeArgs({ ...base, flags: ['--publish', '--key-secret'], secret: 'b'.repeat(64) })).toContain('--p2p-port')
    expect(nodeArgs({ ...base, flags: ['--punch-port'] })).toContain('--p2p-port')
  })

  it('passes the relay the person named, and refuses to drop it for a component that has no such flag', () => {
    const relay = '/ip4/145.40.68.4/tcp/4001/p2p/12D3KooWRelayRelay'
    const named = readConfig(env({ ...good, relay }))
    const args = nodeArgs({ ...base, config: named, flags: [...punching, '--relay'], secret: 'b'.repeat(64) })
    expect(args.slice(args.indexOf('--relay'), args.indexOf('--relay') + 2)).toEqual(['--relay', relay])
    expect(() => nodeArgs({ ...base, config: named, flags: [...punching], secret: 'b'.repeat(64) })).toThrow(/--relay/)
    expect(nodeArgs({ ...base, flags: [...punching, '--relay'], secret: 'b'.repeat(64) })).not.toContain('--relay')
  })

  it('listens, not punches, in an isolated run: loopback has no router', () => {
    const peer = '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAbCdEfGhIjKlMn'
    const args = nodeArgs({ ...base, config: readConfig(env({ ...good, isolated: { bootstrap: [peer] } })), flags: [...punching], secret: 'b'.repeat(64) })
    expect(args).toContain('--p2p-port')
    expect(args).not.toContain('--punch-port')
  })

  it('runs an isolated node on loopback with its DHT started from the given peers, and gives it no HTTP router', () => {
    const peer = '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAbCdEfGhIjKlMn'
    const args = nodeArgs({ ...base, config: readConfig(env({ ...good, isolated: { bootstrap: [peer] } })), flags: ['--publish', '--http-router', '--keys-in-memory'] })
    expect(args.slice(args.indexOf('--allow-local-dial'))).toEqual(['--allow-local-dial', '--test-bootstrap', peer])
    expect(args).not.toContain('--http-router')
  })

  it('asks the loopback routers an isolated run names, and no other', () => {
    const peer = '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAbCdEfGhIjKlMn'
    const config = readConfig(env({ ...good, isolated: { bootstrap: [peer], routers: ['http://127.0.0.1:5001'] } }))
    expect(config.isolated).toEqual({ bootstrap: [peer], routers: ['http://127.0.0.1:5001'] })
    const args = nodeArgs({ ...base, config, flags: ['--publish', '--http-router', '--keys-in-memory'] })
    expect(args.slice(args.indexOf('--http-router'))).toEqual(['--http-router', 'http://127.0.0.1:5001'])
    expect(nodeArgs({ ...base, config, flags: ['--publish', '--keys-in-memory'] })).not.toContain('--http-router')
    for (const router of ['https://127.0.0.1:5001', 'http://example.com:5001', 'http://127.0.0.1', 7]) expect(() => readConfig(env({ ...good, isolated: { bootstrap: [peer], routers: [router] } }))).toThrow(/isolated\.routers/)
  })
})

const PEER = '12D3KooWRelayRelay'
const relayAt = (host: string, port = 4001) => `/${host.includes(':') ? 'ip6' : 'ip4'}/${host}/tcp/${String(port)}/p2p/${PEER}`
const INTERNET = /relay must be on the internet: the node refuses a relay on this computer or the local network/

// The node component refuses a relay unless the address is public (`node.rs` `parse_dial_addr`, with `addr.rs`
// `ipv4_is_public`, `ipv6_is_public` and `dns_name_is_local`), and stays "Restarting" until the person removes it, so the
// dashboard's check refuses what the node refuses, at the field, with a reason.
describe('checkRelay, refuses every address the node refuses', () => {
  it.each([
    // loopback, private, link-local, unspecified, broadcast, multicast
    '127.0.0.1', '127.9.9.9', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.2', '169.254.1.1', '0.0.0.0', '0.1.2.3', '255.255.255.255', '224.0.0.1', '239.255.255.255',
    // documentation ranges
    '192.0.2.1', '192.0.2.254', '198.51.100.4', '203.0.113.7',
    // shared address space (carrier-grade NAT), 100.64.0.0/10
    '100.64.0.1', '100.100.100.100', '100.127.255.255'
  ])('an IPv4 relay at %s', (host) => {
    expect(() => checkRelay(relayAt(host))).toThrow(INTERNET)
  })

  it.each([
    '::1', '::', 'ff02::1', 'ff00::', 'fc00::1', 'fd12:3456::7', 'fe80::1', 'febf::1',
    // an IPv4 address written as IPv6 is judged as the IPv4 address
    '::ffff:a00:1', '::ffff:7f00:1', '::ffff:c0a8:102', '::ffff:cb00:7107'
  ])('an IPv6 relay at %s', (host) => {
    expect(() => checkRelay(relayAt(host))).toThrow(INTERNET)
  })

  it.each(['localhost', 'LOCALHOST', 'localhost.', 'relay.localhost', 'Relay.LocalHost.', 'relay.local'])('a name, %s, that is the computer or the local network', (name) => {
    expect(() => checkRelay(`/dns4/${name}/tcp/4001/p2p/${PEER}`)).toThrow(INTERNET)
    expect(() => checkRelay(`/dns6/${name}/tcp/4001/p2p/${PEER}`)).toThrow(INTERNET)
  })

  it.each([
    '1.1.1.1', '8.8.4.4', '145.40.68.4', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.0.3.1', '192.167.1.1', '198.51.101.1', '203.0.114.1', '223.255.255.255', '169.253.1.1'
  ])('an IPv4 relay at %s, which is public', (host) => {
    expect(checkRelay(relayAt(host))).toBe(relayAt(host))
  })

  it.each(['2606:4700::1111', '2001:db8::7', '2a00:1450:4001::1', '::ffff:808:808', 'fe00::1', 'fec0::1'])('an IPv6 relay at %s, which is public', (host) => {
    expect(checkRelay(relayAt(host))).toBe(relayAt(host))
  })

  it.each(['relay.example.org', 'locally.example', 'notlocalhost', 'localhost.example.org'])('a name, %s, that is not the computer', (name) => {
    expect(checkRelay(`/dns4/${name}/tcp/443/p2p/${PEER}`)).toContain(name)
  })

  it('names the shape, not the internet, when the address is not one the node can read', () => {
    for (const bad of [relayAt('256.1.1.1'), relayAt('1.2.3'), relayAt('01.2.3.4'), relayAt('1.1.1.1', 65536), relayAt(':::'), relayAt('1:2:3:4:5:6:7:8:9'), relayAt('1::2::3'), relayAt('12345::1')]) {
      expect(() => checkRelay(bad), bad).toThrow(/relay must be \/ip4\|ip6/)
    }
  })

  it('lets an isolated run, which dials the local network on purpose, name any of them', () => {
    for (const host of ['127.0.0.1', '192.0.2.1', '198.51.100.4', '::1']) expect(checkRelay(relayAt(host), true)).toBe(relayAt(host))
    expect(checkRelay(`/dns4/localhost/tcp/4001/p2p/${PEER}`, true)).toContain('localhost')
  })
})

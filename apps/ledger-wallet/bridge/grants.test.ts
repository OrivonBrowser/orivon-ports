// What orivon.json grants, read as a person reads the consent prompt: one hardware
// vendor, named hosts rather than every host, and none of the analytics services
// Ledger Wallet's renderer would otherwise talk to.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface Manifest {
  capabilities: {
    net: { https: { connect: string[] } }
    devices: { hid: Array<{ vendorId: number, productId?: number }> }
    web: { embed: { origins: string[] } }
    media: { camera: true }
  }
}
const manifest = JSON.parse(readFileSync(new URL('../orivon.json', import.meta.url), 'utf8')) as Manifest
const hosts = manifest.capabilities.net.https.connect

describe('the grants', () => {
  it('asks for Ledger\'s USB vendor id and nothing broader', () => {
    expect(manifest.capabilities.devices.hid).toEqual([{ vendorId: 0x2c97 }])
  })

  it('names every network host, each on 443, and never "any host"', () => {
    expect(hosts.length).toBeGreaterThan(50)
    for (const pattern of hosts) expect(pattern, pattern).toMatch(/^[a-z0-9.-]+:443$/)
    expect(hosts).not.toContain('*:*')
  })

  it('reaches the services the wallet is for: the manager, the script runner socket, the catalogue, the relay', () => {
    for (const host of ['manager.api.live.ledger.com', 'scriptrunner.api.live.ledger.com', 'live-app-catalog.ledger.com', 'countervalues.live.ledger.com', 'relay.walletconnect.com']) {
      expect(hosts, host).toContain(`${host}:443`)
    }
  })

  it('leaves out analytics, telemetry, staging and test hosts, and reaches Google only for remote-config feature flags', () => {
    const banned = /segment|datadog|braze|sentry|ledgerb\.api|stg|staging|test|sepolia|westend|mock|preprod/i
    expect(hosts.filter((pattern) => banned.test(pattern))).toEqual([])
    expect(hosts.filter((pattern) => /google|firebase/.test(pattern)).sort()).toEqual(['firebaseinstallations.googleapis.com:443', 'firebaseremoteconfig.googleapis.com:443'])
  })

  it('shows Live Apps from any site, since the catalogue is served remotely', () => {
    expect(manifest.capabilities.web.embed.origins).toEqual(['*'])
  })
})

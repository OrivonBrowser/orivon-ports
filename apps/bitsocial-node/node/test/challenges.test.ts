// The anti-spam challenges the node bundles: which, under what names, what each one is (version, licence, the hosts it reaches),
// that every name is registered where pkc-js looks a challenge up, and that the ones the node cannot run say why.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ALL, BUNDLED, describeChallenges, EXCLUDED, OWN, registerChallenges } from '../worker/challenges.js'
import { ETH_RPC_URLS } from '../worker/pkc-options.js'

const NODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const installed = (name: string): { version: string, license: string } => JSON.parse(readFileSync(join(NODE_DIR, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
const pinned: Record<string, string> = JSON.parse(readFileSync(join(NODE_DIR, 'package.json'), 'utf8')).dependencies

/** What `bitsocial challenge install` is told to install by the CLI's documentation and the challenge composer's list, and the one the board manager's preset uses. */
const KNOWN = [
  '@bitsocial/ai-moderation-challenge', '@bitsocial/base64-challenge', '@bitsocial/captcha-canvas-challenge', '@bitsocial/evm-contract-challenge',
  '@bitsocial/flags-challenge', '@bitsocial/mintpass-challenge', '@bitsocial/r9k-challenge', '@bitsocial/spam-blocker-challenge',
  '@bitsocial/voucher-challenge', '@bitsocial/wordfilter-challenge'
]

describe('the list', () => {
  it('has every package the CLI and the composer know, each bundled or left out, none both', () => {
    const bundled = BUNDLED.map((one) => one.name)
    const excluded = EXCLUDED.map((one) => one.name)
    expect([...bundled, ...excluded].sort()).toEqual([...KNOWN].sort())
    expect(bundled.filter((name) => excluded.includes(name))).toEqual([])
  })

  it.each(BUNDLED.map((one) => [one.name, one] as const))('says of %s what the installed package is: its version, its licence, the version package.json pins', (name, one) => {
    const real = installed(name)
    expect(one.version).toBe(real.version)
    expect(one.licence).toBe(real.license)
    expect(pinned[name]).toBe(real.version)
    expect(typeof one.factory).toBe('function')
  })

  it('names the hosts a challenge reaches, and the options that name one, as plain host names', () => {
    for (const one of BUNDLED) {
      for (const host of one.hosts) expect(host, one.name).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/)
      expect(Array.isArray(one.hostOptions), one.name).toBe(true)
    }
    const hostsOf = (name: string) => BUNDLED.find((one) => one.name === name)?.hosts
    expect(hostsOf('@bitsocial/spam-blocker-challenge')).toEqual(['spamblocker.bitsocial.net'])
    expect(hostsOf('@bitsocial/flags-challenge')).toEqual(['flags.5chan.app'])
    expect(hostsOf('@bitsocial/wordfilter-challenge')).toEqual([])
    expect(hostsOf('@bitsocial/evm-contract-challenge')).toEqual(['ethereum.reth.rs'])
    expect(BUNDLED.find((one) => one.name === '@bitsocial/evm-contract-challenge')?.hostOptions).toEqual(['rpcUrls'])
  })

  it('names for the evm-contract challenge the server its own copy of viem reads Ethereum from', async () => {
    // The bundle resolves `viem` from the challenge package first, so its default server for Ethereum is the one that copy's chain table names
    // (the copy the Worker itself carries may name another).
    const fromChallenge = createRequire(join(NODE_DIR, 'node_modules', '@bitsocial', 'evm-contract-challenge', 'dist', 'index.js'))
    const chains = await import(/* @vite-ignore */ pathToFileURL(fromChallenge.resolve('viem/chains')).href) as { mainnet?: { rpcUrls: { default: { http: string[] } } }, default?: { mainnet: { rpcUrls: { default: { http: string[] } } } } }
    const mainnet = chains.mainnet ?? chains.default?.mainnet
    const named = (mainnet?.rpcUrls.default.http ?? []).map((url) => new URL(url).hostname)
    expect(named.length).toBe(1)
    expect(BUNDLED.find((one) => one.name === '@bitsocial/evm-contract-challenge')?.hosts).toEqual(named)
  })

  it('leaves out only a challenge that needs a native module, says so, and has no code for it', () => {
    expect(EXCLUDED.map((one) => one.name)).toEqual(['@bitsocial/mintpass-challenge'])
    for (const one of EXCLUDED) {
      expect(one.reason, one.name).toMatch(/native module/)
      expect(one.reason, one.name).toMatch(/not available in this build/)
      expect(one, one.name).not.toHaveProperty('factory')
    }
  })

  it('does not bundle a package whose dependencies hold a native module the build cannot replace', () => {
    for (const one of BUNDLED) {
      const own = installed(one.name) as { dependencies?: Record<string, string> }
      const names = Object.keys(own.dependencies ?? {})
      expect(names.filter((name) => ['better-sqlite3', 'sqlite3', '@keyv/sqlite', 'node-gyp'].includes(name)), one.name).toEqual([])
    }
  })
})

describe('the evm-contract challenge on a browser with a light client', () => {
  const EVM = '@bitsocial/evm-contract-challenge'
  const ENDPOINT = 'http://ethereum.test'
  const seen: Array<Record<string, unknown> | undefined> = []
  const fake = () => ({
    type: 'text/plain', description: 'the fake', optionInputs: [{ option: 'rpcUrls' }], extra: 1,
    getChallenge: async (args: { challengeSettings: { options?: Record<string, unknown> } }) => { seen.push(args.challengeSettings.options); return { success: true } },
    validateChallengeSettings: () => 'checked'
  })
  const registered = (ethereumUrl?: string) => {
    const registry: Record<string, any> = {}
    registerChallenges(registry, ALL.map((one) => (one.name === EVM ? { ...one, factory: fake as never } : one)), ethereumUrl === undefined ? {} : { ethereumUrl })
    return registry
  }
  const read = async (options: Record<string, unknown> | undefined) => {
    seen.length = 0
    await registered(ENDPOINT)[EVM]({ challengeSettings: {} }).getChallenge({ challengeSettings: { options }, challengeRequestMessage: {}, community: {} })
    return seen[0]
  }

  it('is given the node\'s Ethereum endpoint as its server when its owner named none, because the package\'s own viem names a public one', async () => {
    expect((await read({ address: '0x1' }))?.['rpcUrls']).toBe(ENDPOINT)
    expect((await read({ chainTicker: 'ETH', rpcUrls: '  ' }))?.['rpcUrls']).toBe(ENDPOINT)
    expect((await read(undefined))?.['rpcUrls']).toBe(ENDPOINT)
  })

  it('keeps the servers its owner named, and every chain but Ethereum', async () => {
    expect((await read({ chainTicker: 'eth', rpcUrls: 'https://own.example' }))?.['rpcUrls']).toBe('https://own.example')
    expect((await read({ chainTicker: 'base' }))?.['rpcUrls']).toBeUndefined()
  })

  it('passes everything else of the challenge on as it is', () => {
    const made = registered(ENDPOINT)[EVM]({ challengeSettings: {} })
    expect(made).toMatchObject({ type: 'text/plain', description: 'the fake', optionInputs: [{ option: 'rpcUrls' }], extra: 1 })
    expect(made.validateChallengeSettings()).toBe('checked')
  })

  it('leaves the registry as it was when there is no endpoint, as on a browser with no light client', () => {
    expect(registered()[EVM]).toBe(fake)
  })
})

describe('registerChallenges', () => {
  it('puts each bundled challenge in the registry under its package name, as the CLI\'s install does, and touches nothing else', () => {
    const builtin = () => ({})
    const registry: Record<string, unknown> = { question: builtin }
    const names = registerChallenges(registry)
    expect(names).toEqual(ALL.map((one) => one.name))
    for (const one of ALL) expect(registry[one.name], one.name).toBe(one.factory)
    expect(registry['question']).toBe(builtin)
    expect(Object.keys(registry)).toHaveLength(ALL.length + 1)
  })

  it('is the same again when it runs twice', () => {
    const registry: Record<string, unknown> = {}
    registerChallenges(registry)
    const before = { ...registry }
    registerChallenges(registry)
    expect(registry).toEqual(before)
  })

  it('registers into the registry pkc-js looks a name up in, and every factory is one pkc-js accepts', async () => {
    const [{ challenges }, { validateChallengeFileFactory }] = await Promise.all([import('@pkcprotocol/pkc-js'), import('@pkcprotocol/pkc-js/challenges')])
    registerChallenges(challenges as Record<string, unknown>)
    try {
      for (const one of ALL) {
        expect(Object.hasOwn(challenges, one.name), one.name).toBe(true)
        expect(() => { validateChallengeFileFactory(challenges[one.name], { name: one.name }) }, one.name).not.toThrow()
        expect(challenges[one.name], one.name).toBe(one.factory)
      }
      expect(typeof challenges['text-math']).toBe('function')
    } finally {
      for (const one of ALL) Reflect.deleteProperty(challenges, one.name)
    }
  }, 120_000)
})

describe('describeChallenges', () => {
  const registered = () => { const registry: Record<string, unknown> = { fail: () => ({ description: 'always fails', type: 'text/plain', optionInputs: [{ option: 'error', label: 'Error' }], getChallenge: () => ({ success: false }) }) }; registerChallenges(registry); return registry }

  it('lists what is registered with its version, licence, description and the schema of its options, and nothing that is a function', () => {
    const { challenges } = describeChallenges(registered())
    expect(challenges.map((one) => one.name)).toEqual(['fail', ...ALL.map((one) => one.name).sort()])
    const wordfilter = challenges.find((one) => one.name === '@bitsocial/wordfilter-challenge')!
    expect(wordfilter).toMatchObject({ source: 'bundled', version: '0.3.1', licence: 'GPL-3.0-or-later', type: 'text/plain', hosts: [] })
    expect(wordfilter.description).toMatch(/word replacements/)
    expect(wordfilter.optionInputs.map((input: { option: string }) => input.option)).toEqual(['wordfilter/v1/rules', 'wordfilter/v1/fieldNames', 'error'])
    expect(JSON.parse(JSON.stringify(challenges))).toEqual(challenges)
    for (const one of challenges) expect(Object.values(one).filter((value) => typeof value === 'function'), one.name).toEqual([])
  })

  it('lists one pkc-js has built in as its own, with no version or licence of ours', () => {
    const fail = describeChallenges(registered()).challenges.find((one) => one.name === 'fail')!
    expect(fail).toEqual({ name: 'fail', source: 'pkc-js', version: null, licence: null, description: 'always fails', type: 'text/plain', optionInputs: [{ option: 'error', label: 'Error' }] })
  })

  it('gives an option schema for every bundled challenge, each option with a name', () => {
    for (const one of describeChallenges(registered()).challenges.filter((entry) => entry.source === 'bundled')) {
      expect(one.optionInputs.length, one.name).toBeGreaterThan(0)
      for (const input of one.optionInputs) expect(typeof input.option, one.name).toBe('string')
    }
  })

  it('reports each left-out challenge with its package, version, licence and reason, so a page can say it is not available', () => {
    const { unavailable } = describeChallenges(registered())
    expect(unavailable).toEqual(EXCLUDED.map((one) => ({ name: one.name, version: one.version, licence: one.licence, reason: one.reason })))
    expect(unavailable[0]?.reason).toMatch(/needs a native module/)
  })

  it('reports a bundled challenge that is not in the registry as unavailable rather than listing it', () => {
    const registry = registered()
    Reflect.deleteProperty(registry, '@bitsocial/r9k-challenge')
    const answer = describeChallenges(registry)
    expect(answer.challenges.map((one) => one.name)).not.toContain('@bitsocial/r9k-challenge')
    expect(answer.unavailable.find((one) => one.name === '@bitsocial/r9k-challenge')?.reason).toMatch(/not registered/)
  })

  it('reports a factory that throws with no settings, with its error, and lists the rest', () => {
    const registry = registered()
    registry['@bitsocial/flags-challenge'] = () => { throw new Error('serviceUrl is required') }
    const { challenges } = describeChallenges(registry)
    expect(challenges.find((one) => one.name === '@bitsocial/flags-challenge')).toMatchObject({ source: 'bundled', error: 'serviceUrl is required', optionInputs: [] })
    expect(challenges.find((one) => one.name === '@bitsocial/base64-challenge')).not.toHaveProperty('error')
  })
})

describe('what a page says of each bundled challenge', () => {
  const registered = () => { const registry: Record<string, unknown> = {}; registerChallenges(registry); return registry }

  it('says in a sentence what a poster is asked, which the list carries for the dashboard', () => {
    for (const one of ALL) expect(one.asks.length, one.name).toBeGreaterThan(20)
    const { challenges } = describeChallenges(registered())
    for (const one of challenges) expect(one.asks, one.name).toBe(ALL.find((entry) => entry.name === one.name)?.asks)
    expect(challenges.find((one) => one.name === '@bitsocial/wordfilter-challenge')?.asks).toMatch(/nothing/i)
    expect(challenges.find((one) => one.name === '@bitsocial/captcha-canvas-challenge')?.asks).toMatch(/picture/i)
  })

  it('names a file under the app\'s files for the one option that must be a file, and for no other, only when told where the files are', () => {
    const named = describeChallenges(registered(), { filesDir: '/app/files' }).challenges
    expect(named.find((one) => one.name === '@bitsocial/r9k-challenge')?.suggested).toEqual({ statePath: '/app/files/challenges/r9k-state.json' })
    expect(named.filter((one) => 'suggested' in one).map((one) => one.name)).toEqual(['@bitsocial/r9k-challenge'])
    expect(describeChallenges(registered()).challenges.filter((one) => 'suggested' in one)).toEqual([])
  })
})

describe('the challenge that is ours', () => {
  const own = () => OWN.find((one) => one.name === '@orivon/id-challenge')!
  const ours = (): { version: string, license: string } => JSON.parse(readFileSync(join(NODE_DIR, 'orivon-id-challenge', 'package.json'), 'utf8'))

  it('is the one Orivon ID challenge, listed beside the packages and never among them', () => {
    expect(OWN.map((one) => one.name)).toEqual(['@orivon/id-challenge'])
    expect(BUNDLED.map((one) => one.name)).not.toContain('@orivon/id-challenge')
    expect(ALL.map((one) => one.name)).toEqual([...BUNDLED, ...OWN].map((one) => one.name))
    expect(typeof own().factory).toBe('function')
  })

  it('says what the package is: its version and licence are its own package.json\'s, and it has no dependency to install', () => {
    expect(own().version).toBe(ours().version)
    expect(own().licence).toBe(ours().license)
    expect(own().licence).toBe('AGPL-3.0-only')
    expect(JSON.parse(readFileSync(join(NODE_DIR, 'orivon-id-challenge', 'package.json'), 'utf8')).dependencies).toBeUndefined()
    expect(readFileSync(join(NODE_DIR, 'orivon-id-challenge', 'LICENSE'), 'utf8')).toMatch(/GNU AFFERO GENERAL PUBLIC LICENSE|AGPL-3\.0-only/)
  })

  it('reaches the Ethereum providers the node\'s own name resolution asks, each as a plain host name, and has no option that names another', () => {
    const hosts = ETH_RPC_URLS.map((url) => new URL(url).hostname)
    expect(own().hosts).toEqual(hosts)
    expect(own().hosts.length).toBe(6)
    expect(own().hostOptions).toEqual([])
  })

  it('tells a board owner what a poster must do, that it is checked on Ethereum, and what happens while no author holds an ID', () => {
    expect(own().asks).toMatch(/author name must be an Orivon ID/)
    expect(own().asks).toMatch(/\.v1\.orivonid\.eth/)
    expect(own().asks).toMatch(/"bitsocial" record/)
    expect(own().asks).toMatch(/id\.orivonstack\.eth/)
    expect(own().asks).toMatch(/if that site has not opened yet, no author has one and this board refuses every post/i)
    expect(own().note).toMatch(/this node/i)
  })

  it('is described to a page like the packages: bundled, with its schema and the hosts', () => {
    const registry: Record<string, unknown> = {}
    registerChallenges(registry)
    const listed = describeChallenges(registry).challenges.find((one) => one.name === '@orivon/id-challenge')!
    expect(listed).toMatchObject({ source: 'bundled', version: own().version, licence: 'AGPL-3.0-only', type: 'text/plain', hosts: own().hosts, hostOptions: [] })
    expect(listed.optionInputs.map((input: { option: string }) => input.option)).toEqual(['error'])
    expect(JSON.parse(JSON.stringify(listed))).toEqual(listed)
  })

  it('says its hosts are the node\'s name providers, which the page replaces with the browser\'s light client while the node reads through it, and no package says so', () => {
    const registry: Record<string, unknown> = {}
    registerChallenges(registry)
    const described = describeChallenges(registry).challenges
    expect(own().viaNames).toBe(true)
    expect(described.filter((one) => 'viaNames' in one).map((one) => one.name)).toEqual(['@orivon/id-challenge'])
    expect(BUNDLED.filter((one) => one.viaNames === true)).toEqual([])
  })
})

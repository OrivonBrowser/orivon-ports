// What is ASGARDEX's own about this bridge: the roster of fourteen globals and
// sixty-nine members, the seven-store file layer over orivon.fs, and two
// decisions invisible from any stack trace -- that a read with nothing stored
// resolves upstream's own default rather than rejecting, and that a partial
// settings save has to come back complete.
//
// The kit's own behaviours and the declaration's gates are covered in
// src/bridge/. What runs below is the composed script, byte for byte what the
// browser is served.
import { describe, expect, it, vi } from 'vitest'
import { bridgeSourceFor, runBridge } from '../../../src/testing/bridge-harness.ts'
import type { LoadOptions } from '../../../src/testing/bridge-harness.ts'

const source = await bridgeSourceFor('asgardex')

const STORE_MEMBERS = ['save', 'remove', 'get', 'exists']

const STORE_GLOBALS = [
  'apiCommonStorage',
  'apiUserNodesStorage',
  'apiUserBondProvidersStorage',
  'apiChainStorage',
  'apiAddressStorage',
  'apiAssetStorage',
  'apiPoolsStorage'
]

/** The global-to-file-name correspondence, the only place it is written down on our side. */
const STORE_FILES: Readonly<Record<string, string>> = {
  apiCommonStorage: 'common',
  apiUserNodesStorage: 'userNodes',
  apiUserBondProvidersStorage: 'userBondProviders',
  apiChainStorage: 'userChains',
  apiAddressStorage: 'userAddresses',
  apiAssetStorage: 'userAssets',
  apiPoolsStorage: 'pools'
}

/** Every `window.<global>.<member>` upstream's own Window declaration promises -- src/shared/api/types.ts and src/shared/api/mpcTypes.ts at the pinned commit. */
const ROSTER: Readonly<Record<string, readonly string[]>> = {
  apiKeystore: ['saveKeystoreWallets', 'exportKeystore', 'load', 'initKeystoreWallets'],
  apiExport: ['saveBalancesJson'],
  apiLang: ['update'],
  apiUrl: ['openExternal'],
  apiHDWallet: [
    'getLedgerAddress', 'verifyLedgerAddress', 'sendLedgerTx', 'depositLedgerTx',
    'approveLedgerERC20Token', 'saveLedgerAddresses', 'getLedgerAddresses'
  ],
  apiAppUpdate: ['checkForAppUpdates'],
  apiMpc: [
    'init', 'dispose', 'cancelKeygen', 'listVaults', 'createFastVault', 'createSecureVault',
    'verifyVault', 'deleteVault', 'renameVault', 'getAddresses', 'getBalances', 'importVault',
    'exportVault', 'openVaultFile', 'lockVault', 'unlockVault', 'isVaultUnlocked', 'signBytes',
    'sendTransaction', 'cancelSigning', 'onCreationProgress', 'onQRCodeReady', 'onDeviceJoined',
    'onSignQRReady', 'onSignDeviceJoined', 'onSignProgress'
  ],
  ...Object.fromEntries(STORE_GLOBALS.map((name) => [name, STORE_MEMBERS]))
}

/** A fake orivon.fs over a Map, with the byte orientation the real one has (capability-api.ts: no encoding option anywhere). */
function fakeFs () {
  const files = new Map<string, Uint8Array>()
  const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  return {
    files,
    api: {
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async (path: string, bytes: Uint8Array) => { files.set(path, bytes) }),
      readFile: vi.fn(async (path: string) => {
        const found = files.get(path)
        if (found === undefined) throw missing(path)
        return found
      }),
      stat: vi.fn(async (path: string) => {
        const found = files.get(path)
        if (found === undefined) throw missing(path)
        return { size: found.length }
      }),
      rm: vi.fn(async (path: string) => { files.delete(path) }),
      userSelected: vi.fn(async () => [])
    }
  }
}

function load (options: LoadOptions = {}) {
  return runBridge(source, options)
}

/** Spreading a LoadedBridge would read its `bridge` getter, which throws for an app that installs fourteen. */
function withFs (extra: Record<string, unknown> = {}) {
  const fs = fakeFs()
  const loaded = load({ orivon: { fs: { ...fs.api, ...extra } } })
  return { loaded, fs, app: loaded.app, globals: loaded.globals }
}

interface HasGlobals { globals: Record<string, { bridge: Record<string, any> }> }

const on = (loaded: HasGlobals, global: string) => loaded.globals[global]?.bridge as Record<string, any>

const json = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes))

describe('the roster', () => {
  const loaded = load({ orivon: {} })

  it('installs exactly the fourteen globals upstream exposes', () => {
    expect(Object.keys(loaded.globals).sort()).toEqual(Object.keys(ROSTER).sort())
  })

  it.each(Object.entries(ROSTER))('%s carries exactly its declared members', (global, members) => {
    expect(Object.keys(on(loaded, global)).sort()).toEqual([...members].sort())
  })

  it('answers sixty-nine members in total', () => {
    const total = Object.values(loaded.globals).reduce((sum, entry) => sum + Object.keys(entry.bridge).length, 0)
    expect(total).toBe(69)
  })
})

describe('the seven file stores', () => {
  it.each(STORE_GLOBALS)('%s reads back exactly what it wrote', async (global) => {
    const loaded = withFs()
    const store = on(loaded, global)

    expect(await store.exists()).toBe(false)
    const saved = await store.save({ version: '1', marker: global })
    expect(saved.marker).toBe(global)
    expect(await store.exists()).toBe(true)
    expect((await store.get()).marker).toBe(global)

    await store.remove()
    expect(await store.exists()).toBe(false)
  })

  it('keeps each store in its own file, so seven identical member names never collide', async () => {
    const loaded = withFs()
    for (const global of STORE_GLOBALS) await on(loaded, global).save({ marker: global })
    expect(loaded.fs.files.size).toBe(STORE_GLOBALS.length)
    for (const global of STORE_GLOBALS) {
      expect((await on(loaded, global).get()).marker).toBe(global)
    }
  })

  // Upstream's getFileContent (src/main/api/fileStore.ts:49-72) writes the
  // default to disk and resolves it when the file is missing, and resolves
  // the default again on any parse error -- it never rejects. The renderer is
  // built on that: its READ streams fall back to an EMPTY collection, so a
  // rejected read used to leave `userChains$` at [] forever and every chain
  // read disabled. Only `common`'s read streams fall back per field, which is
  // why generalising from it was the mistake.
  it.each(STORE_GLOBALS)('%s resolves its upstream default when nothing is stored', async (global) => {
    const loaded = withFs()
    const fileName = STORE_FILES[global] as string
    expect(await on(loaded, global).get()).toEqual((loaded.app.STORE_DEFAULTS as Record<string, unknown>)[fileName])
  })

  // A user who turned every chain off keeps them off: the merge is shallow
  // and a partial save carries a whole array, so the default never leaks
  // back in over a stored empty one.
  it('a stored empty collection wins over the default', async () => {
    const store = on(withFs(), 'apiChainStorage')
    await store.save({ chains: [] })
    expect((await store.get()).chains).toEqual([])
  })

  // Upstream seeds the file on first read; this bridge does not, and nothing
  // in the renderer calls exists() to notice, so the profile stays empty
  // until the user changes something.
  it('a first read writes nothing', async () => {
    const loaded = withFs()
    await on(loaded, 'apiChainStorage').get()
    expect(loaded.fs.files.size).toBe(0)
  })

  it('refuses by name when the fs grant was declined', async () => {
    const store = on(load({ orivon: {} }), 'apiCommonStorage')
    await expect(store.get()).rejects.toMatchObject({
      name: 'OrivonBridgeError', member: 'get', reason: 'not-built', owner: 'apiCommonStorage'
    })
  })
})

describe('the two stores that were actually broken', () => {
  // THE bug this port exists to fix: with an unseeded read rejecting,
  // userChains$ emitted [] and Swap.tsx's
  // `defaultChains.filter(c => !enabledChains.has(c))` marked every chain
  // disabled -- and every Rx.combineLatest([]) fed by it (LP shares, wallet
  // history, TCY) never emitted past RD.pending / RD.initial.
  it('apiChainStorage answers the twenty chains upstream enables by default', async () => {
    const stored = await on(withFs(), 'apiChainStorage').get()
    expect(stored.version).toBe('3')
    expect(stored.chains).toEqual([
      'BCH', 'BTC', 'GAIA', 'DOGE', 'ETH', 'LTC', 'THOR', 'ARB', 'AVAX', 'BSC',
      'MAYA', 'DASH', 'XRD', 'SOL', 'BASE', 'ADA', 'ZEC', 'XRP', 'TRON', 'SUI'
    ])
  })

  it('apiAssetStorage answers the nine default user assets', async () => {
    const stored = await on(withFs(), 'apiAssetStorage').get()
    expect(stored.version).toBe('3')
    expect(stored.assets).toHaveLength(9)
    expect(stored.assets.map((a: { ticker: string }) => a.ticker)).toEqual(
      ['USDT', 'USDC', 'USDC', 'USDT', 'USDT', 'USDC', 'USDC', 'LUSD', 'DAI'])
    expect(new Set(stored.assets.map((a: { chain: string }) => a.chain))).toEqual(new Set(['ETH', 'BSC', 'AVAX', 'ARB']))
    // AssetType.TOKEN is a numeric enum; the on-disk value is its ordinal.
    expect(stored.assets.every((a: { type: number }) => a.type === 1)).toBe(true)
  })
})

describe('the settings store', () => {
  it('pins the key set upstream DEFAULT_STORAGES.common carries at the pinned commit', () => {
    const defaults = (withFs().app.STORE_DEFAULTS as Record<string, Record<string, unknown>>).common as Record<string, unknown>
    expect(Object.keys(defaults).sort()).toEqual([
      'arbRpc', 'avaxRpc', 'baseRpc', 'bscRpc', 'ethRpc', 'evmDerivationMode', 'evmGasMultiplier',
      'locale', 'mayanodeApi', 'mayanodeRpc', 'midgard', 'midgardMaya', 'thornodeApi',
      'thornodeRpc', 'version'
    ])
  })

  // The storage version each store carries at the pinned commit. The bridge's
  // own file path does not encode it (unlike upstream's, which does), so a
  // version bump upstream is invisible here until this pin catches it -- see
  // ../UPSTREAM.md for what that divergence costs and when to fix it.
  it('pins the storage version upstream carries for each store', () => {
    const defaults = withFs().app.STORE_DEFAULTS as Record<string, { version: string }>
    expect(Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, v.version]))).toEqual({
      common: '1', userNodes: '1', userBondProviders: '1', userChains: '3',
      userAddresses: '1', userAssets: '3', pools: '1'
    })
  })

  // THE regression this port exists to avoid. The renderer saves a partial
  // (services/midgard/thorMidgard/service.ts:60) and then REPLACES its whole
  // settings state with whatever comes back (services/storage/common.ts:161).
  // A merge that skipped the defaults would return { midgard } alone, and
  // every other endpoint would read undefined -- clients built on a relative
  // URL, a wall of silent 404s, and no exception anywhere.
  it('returns a complete record from a partial save', async () => {
    const loaded = withFs()
    const store = on(loaded, 'apiCommonStorage')
    const defaults = (loaded.app.STORE_DEFAULTS as Record<string, Record<string, unknown>>).common as Record<string, unknown>

    const saved = await store.save({ midgard: { mainnet: 'https://midgard.example', stagenet: '', testnet: '' } })

    expect(Object.keys(saved).sort()).toEqual(Object.keys(defaults).sort())
    expect(saved.midgard.mainnet).toBe('https://midgard.example')
    expect(saved.thornodeApi).toEqual(defaults.thornodeApi)
    expect(saved.locale).toBe(defaults.locale)
  })

  it('keeps an earlier save when a later one touches a different key', async () => {
    const store = on(withFs(), 'apiCommonStorage')
    await store.save({ locale: 'fr' })
    const second = await store.save({ evmGasMultiplier: 3 })
    expect(second.locale).toBe('fr')
    expect(second.evmGasMultiplier).toBe(3)
  })
})

describe('keystore wallets', () => {
  it('starts from an fp-ts Right holding no wallets', async () => {
    expect(await on(withFs(), 'apiKeystore').initKeystoreWallets()).toEqual({ _tag: 'Right', right: [] })
  })

  it('round-trips the encoded wallets it was handed, without inspecting them', async () => {
    const loaded = withFs()
    const keystore = on(loaded, 'apiKeystore')
    const wallets = [{ id: 1, name: 'Wallet 1', selected: true, keystore: { crypto: 'opaque' } }]

    expect(await keystore.saveKeystoreWallets(wallets)).toEqual({ _tag: 'Right', right: wallets })
    expect(await keystore.initKeystoreWallets()).toEqual({ _tag: 'Right', right: wallets })
  })

  it('reports a write failure as an fp-ts Left rather than rejecting', async () => {
    const loaded = load({ orivon: { fs: { ...fakeFs().api, mkdir: async () => { throw new Error('quota') } } } })
    const result = await on(loaded, 'apiKeystore').saveKeystoreWallets([])
    expect(result._tag).toBe('Left')
    // Shape, not constructor: the bridge builds its Error in the sandbox's own
    // realm, so `instanceof` against this file's Error is false here and true
    // in a browser, which has one realm.
    expect(result.left.message).toContain('quota')
  })
})

describe('the three file-exchange members', () => {
  function pickedFolder () {
    const writeFile = vi.fn(async (_name: string, _bytes: Uint8Array) => {})
    const userSelected = vi.fn(async () => ({ writeFile }))
    return { writeFile, userSelected }
  }

  it('exportKeystore writes into a folder the user picked, and returns nothing', async () => {
    const folder = pickedFolder()
    const loaded = withFs({ userSelected: folder.userSelected })
    const keystore = { crypto: 'opaque' }

    const returned = await on(loaded, 'apiKeystore').exportKeystore({ fileName: 'keystore.json', keystore })

    expect(returned).toBeUndefined()
    expect(folder.userSelected).toHaveBeenCalledWith({ directory: true })
    const [name, bytes] = folder.writeFile.mock.calls[0] as [string, Uint8Array]
    expect(name).toBe('keystore.json')
    expect(json(bytes)).toEqual(keystore)
  })

  it('saveBalancesJson writes the balances the same way', async () => {
    const folder = pickedFolder()
    const loaded = withFs({ userSelected: folder.userSelected })
    const data = { walletName: 'Wallet 1', balances: [] }

    await on(loaded, 'apiExport').saveBalancesJson({ fileName: 'balances.json', data })

    const [name, bytes] = folder.writeFile.mock.calls[0] as [string, Uint8Array]
    expect(name).toBe('balances.json')
    expect(json(bytes)).toEqual(data)
  })

  it('writes nothing when the picker is cancelled', async () => {
    const folder = pickedFolder()
    folder.userSelected.mockResolvedValue(null as never)
    const loaded = withFs({ userSelected: folder.userSelected })

    await on(loaded, 'apiKeystore').exportKeystore({ fileName: 'keystore.json', keystore: {} })
    expect(folder.writeFile).not.toHaveBeenCalled()
  })

  // The escape test (docs/porting-guide.md): upstream's dialog hands the
  // renderer a host path, orivon.fs.userSelected hands the bridge an opaque
  // handle. `load` resolves the PARSED keystore, so the handle stays in the
  // bridge's closure and no path reaches app code.
  it('load resolves the parsed keystore, never a path', async () => {
    const keystore = { crypto: 'opaque', version: 1 }
    const bytes = new TextEncoder().encode(JSON.stringify(keystore))
    const handle = {
      stat: vi.fn(async () => ({ size: bytes.length })),
      read: vi.fn(async () => bytes)
    }
    const loaded = withFs({ userSelected: vi.fn(async () => [handle]) })

    const result = await on(loaded, 'apiKeystore').load()

    expect(result).toEqual(keystore)
    expect(handle.read).toHaveBeenCalledWith({ position: 0, length: bytes.length })
    expect(JSON.stringify(result)).not.toMatch(/\//)
  })

  it('load resolves undefined when the picker is cancelled', async () => {
    const loaded = withFs({ userSelected: vi.fn(async () => []) })
    expect(await on(loaded, 'apiKeystore').load()).toBeUndefined()
  })
})

describe('external links', () => {
  it('openExternal opens a tab rather than reaching for a shell', async () => {
    const open = vi.fn()
    const loaded = load({ orivon: {} })
    // A browser's `window` IS the global object; the harness's realm has a
    // plain one, so the tab-opener goes on the object the bridge reads.
    loaded.sandbox.window.open = open
    await on(loaded, 'apiUrl').openExternal('https://runescan.io/tx/ABC')
    expect(open).toHaveBeenCalledWith('https://runescan.io/tx/ABC', '_blank', 'noopener,noreferrer')
  })
})

describe('the MPC listeners', () => {
  const NAMES = ['onCreationProgress', 'onQRCodeReady', 'onDeviceJoined', 'onSignQRReady', 'onSignDeviceJoined', 'onSignProgress']

  // Each is called from a React effect and its return value from that effect's
  // teardown, so it has to be a function -- the kit's `listeners` recorder
  // returns undefined, which is why these six are hand-written.
  it.each(NAMES)('%s records the callback, never fires it, and returns an unsubscribe', (name) => {
    const loaded = withFs()
    const callback = vi.fn()

    const unsubscribe = on(loaded, 'apiMpc')[name](callback)

    expect(unsubscribe).toBeTypeOf('function')
    expect(callback).not.toHaveBeenCalled()
    expect((loaded.app.mpcRecorded as Record<string, unknown>)[name]).toBe(callback)
    expect(() => { unsubscribe() }).not.toThrow()
    expect((loaded.app.mpcRecorded as Record<string, unknown>)[name]).toBeUndefined()
  })
})

describe('the members that answer a constant', () => {
  const loaded = load({ orivon: {} })

  it('apiLang.update is inert: there is no native menu to relabel', () => {
    expect(on(loaded, 'apiLang').update('fr')).toBeUndefined()
  })

  it('apiMpc reports an SDK that is not up, and no vaults', async () => {
    const mpc = on(loaded, 'apiMpc')
    expect(await mpc.init()).toEqual({ initialized: false })
    expect(await mpc.listVaults()).toEqual([])
    expect(await mpc.isVaultUnlocked('any')).toBe(false)
    await expect(mpc.dispose()).resolves.toBeNull()
    await expect(mpc.cancelKeygen()).resolves.toBeNull()
  })

  // Read while the wallet view mounts: it answers instead of refusing, so the
  // page renders showing no Ledger accounts rather than failing to load.
  it('apiHDWallet.getLedgerAddresses answers a Right holding no addresses', async () => {
    expect(await on(loaded, 'apiHDWallet').getLedgerAddresses()).toEqual({ _tag: 'Right', right: [] })
  })

  // useAppUpdate.ts hands this call's result straight to Rx.from, so a
  // synchronous throw would escape its own catchError. It answers instead,
  // with remote-data-ts's own success-of-none: checked, nothing newer.
  it('apiAppUpdate.checkForAppUpdates reports no newer release rather than throwing past the app', async () => {
    const result = await on(loaded, 'apiAppUpdate').checkForAppUpdates()
    expect(result).toEqual({ _tag: 'RemoteSuccess', value: { _tag: 'None' } })
  })
})

describe('the members that refuse', () => {
  const loaded = load({ orivon: {} })

  const REFUSED: ReadonlyArray<[string, string, string]> = [
    ['apiHDWallet', 'getLedgerAddress', 'not-built'],
    ['apiHDWallet', 'verifyLedgerAddress', 'not-built'],
    ['apiHDWallet', 'sendLedgerTx', 'not-built'],
    ['apiHDWallet', 'depositLedgerTx', 'not-built'],
    ['apiHDWallet', 'approveLedgerERC20Token', 'not-built'],
    ['apiHDWallet', 'saveLedgerAddresses', 'not-built'],
    ['apiMpc', 'createFastVault', 'not-built'],
    ['apiMpc', 'createSecureVault', 'not-built'],
    ['apiMpc', 'verifyVault', 'not-built'],
    ['apiMpc', 'deleteVault', 'not-built'],
    ['apiMpc', 'renameVault', 'not-built'],
    ['apiMpc', 'getAddresses', 'not-built'],
    ['apiMpc', 'getBalances', 'not-built'],
    ['apiMpc', 'importVault', 'not-built'],
    ['apiMpc', 'exportVault', 'not-built'],
    ['apiMpc', 'openVaultFile', 'not-built'],
    ['apiMpc', 'lockVault', 'not-built'],
    ['apiMpc', 'unlockVault', 'not-built'],
    ['apiMpc', 'signBytes', 'not-built'],
    ['apiMpc', 'sendTransaction', 'not-built'],
    ['apiMpc', 'cancelSigning', 'not-built']
  ]

  it('covers every refused member the declaration names', () => {
    expect(REFUSED).toHaveLength(21)
  })

  it.each(REFUSED)('%s.%s throws naming the global, the member and the reason', (global, member, reason) => {
    expect(() => on(loaded, global)[member]()).toThrow(new RegExp(`^${global}\\.${member} is unavailable`))
    try {
      on(loaded, global)[member]()
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toMatchObject({ name: 'OrivonBridgeError', member, reason, owner: global })
    }
  })

  // Nothing here is reached while the page mounts: every one of them sits
  // behind a device, a vault or a settings button the port has already
  // answered as absent.
  it('never refuses a member the wallet view reads on the way up', () => {
    const onMount = ['getLedgerAddresses', 'listVaults', 'init', 'isVaultUnlocked']
    for (const member of onMount) {
      expect(REFUSED.some(([, name]) => name === member)).toBe(false)
    }
  })
})

// The forty members that carry a decision rather than a shape: everything
// backed by orivon.fs, plus the six MPC listeners, which have to hand the app
// back an unsubscribe the kit's own `listeners` bucket does not return.
//
// The other twenty-nine are declared in ./members.json and generated. See
// ../README.md for the table and the reasoning; this file is spliced into the
// composed bridge, so it is not a module -- it declares `appMembers`, which
// the installer calls with the kit, and returns one member map per global.

function appMembers (kit) {
  const { BridgeError } = kit

  // Upstream's main process seeds a store file with its own default on first
  // read and merges every read and every write against it
  // (src/main/api/fileStore.ts: getFileContent/saveToFile), so a read NEVER
  // rejects and a save always resolves a COMPLETE record. Every store below
  // reproduces that -- STORE_DEFAULTS, further down, is looked up by file
  // name inside `fileStore` itself. Each default was evaluated from
  // src/shared/const.ts at the pinned commit, never typed by hand;
  // ../UPSTREAM.md says which ones carry real risk when the pin moves.
  //
  // `common` additionally needs its default merged back into every SAVE: the
  // renderer replaces its whole settings state with whatever comes back
  // (services/storage/common.ts) and sends PARTIAL saves, so a merge that
  // skipped these would blank every field the save did not mention -- and
  // fp-ts would not catch it, because O.map over a missing key yields
  // Some(undefined) rather than None. ../README.md's Design notes has the
  // whole argument.
  const COMMON_DEFAULTS = {
    "version": "1",
    "evmDerivationMode": "ledgerlive",
    "locale": "en",
    "midgard": {
      "mainnet": "https://gateway.liquify.com/chain/thorchain_midgard",
      "stagenet": "",
      "testnet": "https://testnet.midgard.thorchain.info"
    },
    "midgardMaya": {
      "mainnet": "https://midgard.mayachain.info",
      "stagenet": "https://stagenet.midgard.mayachain.info",
      "testnet": "https://testnet.midgard.thorchain.info"
    },
    "thornodeApi": {
      "mainnet": "https://gateway.liquify.com/chain/thorchain_api",
      "stagenet": "",
      "testnet": "https://testnet.thornode.thorchain.info"
    },
    "thornodeRpc": {
      "mainnet": "https://gateway.liquify.com/chain/thorchain_rpc",
      "stagenet": "",
      "testnet": ""
    },
    "mayanodeApi": {
      "mainnet": "https://mayanode.mayachain.info",
      "stagenet": "https://stagenet.mayanode.mayachain.info",
      "testnet": "https://testnet.mayanode.mayachain.info"
    },
    "mayanodeRpc": {
      "mainnet": "https://tendermint.mayachain.info",
      "stagenet": "https://tendermint.mayachain.info",
      "testnet": "https://tendermint.mayachain.info"
    },
    "ethRpc": {
      "mainnet": "https://ethereum.publicnode.com",
      "stagenet": "https://ethereum.publicnode.com",
      "testnet": "https://ethereum-sepolia-rpc.publicnode.com"
    },
    "bscRpc": {
      "mainnet": "https://bsc-dataseed.binance.org/",
      "stagenet": "https://bsc-dataseed.binance.org/",
      "testnet": "https://data-seed-prebsc-1-s1.binance.org:8545/"
    },
    "arbRpc": {
      "mainnet": "https://arb1.arbitrum.io/rpc",
      "stagenet": "https://arb1.arbitrum.io/rpc",
      "testnet": "https://sepolia-rollup.arbitrum.io/rpc"
    },
    "avaxRpc": {
      "mainnet": "https://api.avax.network/ext/bc/C/rpc",
      "stagenet": "https://api.avax.network/ext/bc/C/rpc",
      "testnet": "https://api.avax-test.network/ext/bc/C/rpc"
    },
    "baseRpc": {
      "mainnet": "https://1rpc.io/base",
      "stagenet": "https://1rpc.io/base",
      "testnet": "https://base-sepolia-rpc.publicnode.com"
    },
    "evmGasMultiplier": 1
  }

  // `pools` needs its default for a second reason beyond the shared contract
  // above: services/storage/pools.ts reads it with a single-argument
  // `.then(...)` and no rejection handler, so if this store's read ever did
  // reject, it would be an unhandled rejection in the renderer rather than a
  // caught one. Upstream's own POOLS_STORAGE_DEFAULT, which is empty
  // watchlists.
  const POOLS_DEFAULTS = { version: '1', watchlists: { mainnet: [], stagenet: [], testnet: [] } }

  // Upstream enables every chain it ships by default (DEFAULT_ENABLED_CHAINS,
  // src/shared/utils/chain.ts); a chain missing here reads as "the user
  // disabled it" everywhere userChains$ is consulted -- the bug this default
  // exists to prevent. `XRD` is RadixChain's own serialisation.
  const CHAINS_DEFAULTS = {
    version: '3',
    chains: [
      'BCH', 'BTC', 'GAIA', 'DOGE', 'ETH', 'LTC', 'THOR', 'ARB', 'AVAX', 'BSC',
      'MAYA', 'DASH', 'XRD', 'SOL', 'BASE', 'ADA', 'ZEC', 'XRP', 'TRON', 'SUI'
    ]
  }

  // AssetType.TOKEN, a NUMERIC enum in @xchainjs/xchain-util -- the stored
  // value below is this ordinal, not the name. A member inserted before
  // TOKEN upstream would change it silently.
  const ASSET_TYPE_TOKEN = 1

  // The nine stablecoins upstream's wallet watches without being asked
  // (DEFAULT_USER_ASSETS, src/renderer/const.ts).
  const ASSETS_DEFAULTS = {
    version: '3',
    assets: [
      { chain: 'ETH', symbol: 'USDT-0xdAC17F958D2ee523a2206206994597C13D831ec7', ticker: 'USDT', type: ASSET_TYPE_TOKEN },
      { chain: 'ETH', symbol: 'USDC-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', ticker: 'USDC', type: ASSET_TYPE_TOKEN },
      { chain: 'BSC', symbol: 'USDC-0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', ticker: 'USDC', type: ASSET_TYPE_TOKEN },
      { chain: 'BSC', symbol: 'USDT-0x55d398326f99059fF775485246999027B3197955', ticker: 'USDT', type: ASSET_TYPE_TOKEN },
      { chain: 'AVAX', symbol: 'USDT-0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', ticker: 'USDT', type: ASSET_TYPE_TOKEN },
      { chain: 'AVAX', symbol: 'USDC-0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', ticker: 'USDC', type: ASSET_TYPE_TOKEN },
      { chain: 'ARB', symbol: 'USDC-0xaf88d065e77c8cc2239327c5edb3a432268e5831', ticker: 'USDC', type: ASSET_TYPE_TOKEN },
      { chain: 'ETH', symbol: 'LUSD-0x5f98805A4E8be255a32880FDeC7F6728C6568bA0', ticker: 'LUSD', type: ASSET_TYPE_TOKEN },
      { chain: 'ETH', symbol: 'DAI-0x6B175474E89094C44Da98b954EedeAC495271d0F', ticker: 'DAI', type: ASSET_TYPE_TOKEN }
    ]
  }

  /** Upstream's DEFAULT_STORAGES (src/shared/const.ts), keyed by store file name. */
  const STORE_DEFAULTS = {
    common: COMMON_DEFAULTS,
    userNodes: { version: '1', mainnet: [], stagenet: [], testnet: [] },
    userBondProviders: { version: '1', mainnet: [], stagenet: [], testnet: [] },
    userChains: CHAINS_DEFAULTS,
    userAddresses: { version: '1', addresses: [] },
    userAssets: ASSETS_DEFAULTS,
    pools: POOLS_DEFAULTS
  }

  const STORAGE_DIR = 'storage'

  /** The app's own confined root. Absent when the fs grant was declined, and then every member below refuses by name rather than at load time. */
  function fsFor (member, owner) {
    const fs = kit.getOrivon()?.fs
    if (fs === undefined) throw new BridgeError(member, 'not-built', 'no fs grant', owner)
    return fs
  }

  const encode = (value) => new TextEncoder().encode(JSON.stringify(value))
  const decode = (bytes) => JSON.parse(new TextDecoder().decode(bytes))

  // fp-ts Either, built as a literal. The renderer pattern-matches on _tag;
  // the bridge depends on no library to say so.
  const right = (value) => ({ _tag: 'Right', right: value })
  const left = (error) => ({ _tag: 'Left', left: error })

  const asError = (cause) => (cause instanceof Error ? cause : new Error(String(cause)))

  async function readJson (fs, path) {
    try {
      return await fs.readFile(path).then(decode)
    } catch {
      return undefined
    }
  }

  async function writeJson (fs, path, value) {
    await fs.mkdir(STORAGE_DIR, { recursive: true })
    await fs.writeFile(path, encode(value))
  }

  /**
   * One of the seven JSON stores, over upstream's own contract: a read never
   * rejects, and with nothing stored it resolves that store's own default
   * (STORE_DEFAULTS, above). The renderer's READ streams fall back to an
   * EMPTY collection when a read rejects, not to the app's own default --
   * `O.getOrElse(() => CHAINS_STORAGE_DEFAULT)` appears only in
   * addChain/removeChain, never in a read stream. So a rejected read used to
   * leave the renderer's state at O.none and, for `userChains$`, emit []
   * forever: every chain read disabled, and every Rx.combineLatest([]) fed by
   * it never emitted again. `common` is the one service whose read streams DO
   * fall back per field (services/storage/common.ts) -- generalising from it
   * is the mistake this contract corrects. ../README.md's Design notes has
   * the four screens that broke while this rejected.
   */
  function fileStore (owner, fileName) {
    const defaults = STORE_DEFAULTS[fileName]
    // At install, before the app's bundle runs: a store with no default is
    // the bug this contract exists to prevent, wearing a different name.
    if (defaults === undefined) throw new Error(`${fileName}: no entry in STORE_DEFAULTS`)
    const path = `${STORAGE_DIR}/${fileName}.json`
    return {
      get: async () => ({ ...defaults, ...(await readJson(fsFor('get', owner), path)) }),
      save: async (data) => {
        const fs = fsFor('save', owner)
        const merged = { ...defaults, ...(await readJson(fs, path)), ...data }
        await writeJson(fs, path, merged)
        return merged
      },
      remove: async () => { await fsFor('remove', owner).rm(path) },
      exists: async () => {
        const fs = fsFor('exists', owner)
        try {
          await fs.stat(path)
          return true
        } catch {
          return false
        }
      }
    }
  }

  const WALLETS_FILE = `${STORAGE_DIR}/wallets.json`

  /**
   * Wallets cross this seam already io-ts-encoded by the renderer and are
   * decoded by it on the way back, so they are stored and returned verbatim.
   * The bridge never inspects keystore material.
   */
  function keystoreApi () {
    const owner = 'apiKeystore'
    return {
      initKeystoreWallets: async () => {
        try {
          const fs = fsFor('initKeystoreWallets', owner)
          return right((await readJson(fs, WALLETS_FILE)) ?? [])
        } catch (cause) {
          return left(asError(cause))
        }
      },
      saveKeystoreWallets: async (wallets) => {
        try {
          await writeJson(fsFor('saveKeystoreWallets', owner), WALLETS_FILE, wallets)
          return right(wallets)
        } catch (cause) {
          return left(asError(cause))
        }
      },
      // Upstream opens a native save dialog. Here the user picks a FOLDER and
      // the bridge writes into it by name: the handle stays in this closure
      // and the app gets back nothing, which is what keeps a host path from
      // escaping into renderer code (docs/porting-guide.md, the escape test).
      exportKeystore: async ({ fileName, keystore }) => {
        const folder = await fsFor('exportKeystore', owner).userSelected({ directory: true })
        if (folder === null || folder === undefined) return
        await folder.writeFile(fileName, encode(keystore))
      },
      // The import half. Resolves the PARSED keystore, never a path, so the
      // renderer receives the same shape Electron's dialog + readJSON gave it.
      load: async () => {
        const picked = await fsFor('load', owner).userSelected()
        const handle = picked?.[0]
        if (handle === undefined) return undefined
        const { size } = await handle.stat()
        return decode(await handle.read({ position: 0, length: size }))
      }
    }
  }

  function exportApi () {
    return {
      saveBalancesJson: async ({ fileName, data }) => {
        const folder = await fsFor('saveBalancesJson', 'apiExport').userSelected({ directory: true })
        if (folder === null || folder === undefined) return
        await folder.writeFile(fileName, encode(data))
      }
    }
  }

  // Upstream routes this through shell.openExternal against an allowlist it
  // keeps in main. A tab is the browser's own answer to a link, and the
  // allowlist went with the main process -- what a person may open is the
  // shell's decision here, not this app's.
  function urlApi () {
    return {
      openExternal: async (url) => { window.open(url, '_blank', 'noopener,noreferrer') }
    }
  }

  /**
   * ApiMpc's six `on*` members return their own unsubscribe, which the app
   * calls from a React effect teardown -- so they cannot use the kit's
   * `listeners` bucket, whose recorder returns undefined. There is no second
   * process to emit anything, so the callback is recorded and never fired,
   * and the unsubscribe forgets it.
   */
  function mpcListeners () {
    const recorded = {}
    const names = ['onCreationProgress', 'onQRCodeReady', 'onDeviceJoined', 'onSignQRReady', 'onSignDeviceJoined', 'onSignProgress']
    const api = {}
    for (const name of names) {
      api[name] = (callback) => {
        recorded[name] = callback
        return () => { delete recorded[name] }
      }
    }
    kit.expose('mpcRecorded', recorded)
    return api
  }

  kit.expose('STORE_DEFAULTS', STORE_DEFAULTS)

  return {
    apiKeystore: keystoreApi(),
    apiExport: exportApi(),
    apiUrl: urlApi(),
    apiCommonStorage: fileStore('apiCommonStorage', 'common'),
    apiUserNodesStorage: fileStore('apiUserNodesStorage', 'userNodes'),
    apiUserBondProvidersStorage: fileStore('apiUserBondProvidersStorage', 'userBondProviders'),
    apiChainStorage: fileStore('apiChainStorage', 'userChains'),
    apiAddressStorage: fileStore('apiAddressStorage', 'userAddresses'),
    apiAssetStorage: fileStore('apiAssetStorage', 'userAssets'),
    apiPoolsStorage: fileStore('apiPoolsStorage', 'pools'),
    apiMpc: mpcListeners()
  }
}

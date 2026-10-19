// What the page checks, and the public services it asks. Data only.

/**
 * One row per IPNS key. `names` are the .eth names that must point at the key; `kind` says
 * how the content is checked: a 'site' is read through its index.html, a 'folder' is listed
 * and each file spot-checked.
 * @typedef {{ id: string, label: string, ipns: string, names: string[], kind: 'site' | 'folder' }} Site
 * @type {Site[]}
 */
export const SITES = [
  { id: 'airgapvault', label: 'AirGap Vault', ipns: 'k51qzi5uqu5dmhqqwks2m6pev89dabyb0yaanc12w0w3v2kccp9b8jiwa038zv', names: ['airgapvault.orivonstack.eth'], kind: 'site' },
  { id: 'asgardex', label: 'ASGARDEX', ipns: 'k51qzi5uqu5di8ki1ddkqyaedoniso15hv6a09lvwnva6bnrzmscjrk1wqkpby', names: ['asgardex.orivonstack.eth'], kind: 'site' },
  { id: 'docs', label: 'Docs', ipns: 'k51qzi5uqu5dlmwc59z8c6m8y7pnp7lbjhz1mexeuh4sswsl2yidc1637facoq', names: ['docs.orivonstack.eth'], kind: 'site' },
  { id: 'element', label: 'Element', ipns: 'k51qzi5uqu5diqloayyi8qyovpykwr5hi3yiqd3buutb697ldlkry0da5442zf', names: ['element.orivonstack.eth'], kind: 'site' },
  { id: 'explore', label: 'Orivon Explore', ipns: 'k51qzi5uqu5dlswot3wcjo7k3vy02gepnrdw2qhu2a3f6ll422kykyoljjshuv', names: ['explore.orivonstack.eth'], kind: 'site' },
  { id: 'freetube', label: 'FreeTube', ipns: 'k51qzi5uqu5dhdec4hp7v8rkef3615rmptylrzzqaqw9nn84gf3ljg1omaf5gv', names: ['freetube.orivonstack.eth'], kind: 'site' },
  { id: 'ledgerwallet', label: 'Ledger Wallet', ipns: 'k51qzi5uqu5dl3wewviuttup4hjmsjjmkx2d1x93vg8xc66jpqenwjvfckimn8', names: ['ledgerwallet.orivonstack.eth'], kind: 'site' },
  { id: 'thelounge', label: 'The Lounge', ipns: 'k51qzi5uqu5dksrrt6x02airgazw9fhir1uewul6or1fn7v9zixnfngu47thhp', names: ['thelounge.orivonstack.eth'], kind: 'site' },
  { id: 'web3-score', label: 'Orivon Attila', ipns: 'k51qzi5uqu5dli7gc98gxy6jlbarijipfrw1x8z2wfyre3rvhssxvzeummkaff', names: ['attila.orivonstack.eth'], kind: 'site' },
  { id: 'website', label: 'Orivon website', ipns: 'k51qzi5uqu5djxiia8zinifneni196scn18sggx6aqh0df5fgd84eh47ok38sn', names: ['orivonstack.eth', 'www.orivonstack.eth', 'download.orivonstack.eth'], kind: 'site' },
  { id: 'webtorrent', label: 'WebTorrent', ipns: 'k51qzi5uqu5dm0v7emn6w75m1jiq7d3e1f4mpulzxslvinf2vupzhnlzz6m2b6', names: ['webtorrent.orivonstack.eth'], kind: 'site' },
  { id: 'latest-release', label: 'Newest release', ipns: 'k51qzi5uqu5dk0x8gxde5wj1emumph2nv110mwa5uo1qv7st6nfpg4pf5ckk0h', names: ['latest.orivonstack.eth'], kind: 'folder' }
  // This page's own key does not exist yet; its row goes here once it does:
  // { id: 'status', label: 'Orivon Status', ipns: '<key>', names: ['status.orivonstack.eth'], kind: 'site' },
]

/** The newest `keep` releases that carry an IPFS address must be served. */
export const RELEASES = { repo: 'OrivonBrowser/orivon-mvp', keep: 3 }

/** Public gateways, in the order they are tried. Pinata serves blocks but not IPNS records. */
export const GATEWAYS = ['https://ipfs.orbitor.dev', 'https://ipfs.filebase.io', 'https://gateway.pinata.cloud']

/** Gateways that also serve IPNS records. */
export const RECORD_GATEWAYS = ['https://ipfs.orbitor.dev', 'https://ipfs.filebase.io']

/** The public IPFS routing service: IPNS records and the providers of a CID. */
export const ROUTING = 'https://delegated-ipfs.dev'

/** Ethereum JSON-RPC endpoints, in the order they are tried. */
export const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://rpc.mevblocker.io']

export const GITHUB_API = 'https://api.github.com'

/** Every host the page contacts: the manifest's https.connect list is exactly this, plus ":443". */
export const HOSTS = [...new Set([...GATEWAYS, ...RPCS, ROUTING, GITHUB_API].map((url) => new URL(url).host))]

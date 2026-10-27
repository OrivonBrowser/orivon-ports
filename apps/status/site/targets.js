// What the page checks, and the public services it asks. Data only.

/**
 * One row per IPNS key. `names` are the .eth names that must point at the key, or at the site's
 * Swarm feed when it has one; `feed` is that feed manifest's reference (64 hex characters), which a
 * name's `bzz://` contenthash carries. `kind` says how the content is checked: a 'site' is read
 * through its index.html, a 'folder' is listed and each file spot-checked. `port` is the app's
 * directory in orivon-ports when it is somebody else's app, which is what lets the page read its pin.
 * @typedef {{ id: string, label: string, ipns: string, feed?: string, names: string[], kind: 'site' | 'folder', port?: string }} Site
 * @type {Site[]}
 */
export const SITES = [
  { id: 'actualbudget', label: 'Actual Budget', ipns: 'k51qzi5uqu5dkqxlo3k3msg6elesc7g1jc9tvnmh0khbo7mdfy7owu40ao6r79', feed: '96234e3224614fc1e28f1d7c49e6d6da70e11210d7e4c46a07655eb6342f5cbb', names: ['actualbudget.orivonstack.eth'], kind: 'site', port: 'actualbudget' },
  { id: 'airgapvault', label: 'AirGap Vault', ipns: 'k51qzi5uqu5dmhqqwks2m6pev89dabyb0yaanc12w0w3v2kccp9b8jiwa038zv', feed: '65c49ec4205589213be9faec9601b717d8f160f01d64fb04e5b07bc6933b2bb3', names: ['airgapvault.orivonstack.eth'], kind: 'site', port: 'airgap-vault' },
  { id: 'asgardex', label: 'ASGARDEX', ipns: 'k51qzi5uqu5di8ki1ddkqyaedoniso15hv6a09lvwnva6bnrzmscjrk1wqkpby', feed: '57487f817267fff639ed803a4f6a8d2c60e985855a0f74a472c14827affff76f', names: ['asgardex.orivonstack.eth'], kind: 'site', port: 'asgardex' },
  { id: 'decentrawiki', label: 'DecentraWiki guide', ipns: 'k51qzi5uqu5djbyqa3cpf5xo4re36vfcsoo8y5ih1rv7e7b06gk7r6rz0tjeuz', feed: '9fa289ad5e815fabcb8e5be8866e382a124e3d3f9a2e689b6e3c48966c0e75fe', names: ['decentrawiki.eth'], kind: 'site' },
  { id: 'decentrawiki-editor', label: 'DecentraWiki editor', ipns: 'k51qzi5uqu5dgou6r9xggf9z2nrgdr7gtjuglbfco4ifp3slanybhx94r5palz', feed: '5dea7c8e098ef880e2223983dcec926d66d69d1d2756e99dbe36196b0dde8257', names: ['editor.decentrawiki.eth'], kind: 'site', port: 'decentrawiki' },
  { id: 'docs', label: 'Docs', ipns: 'k51qzi5uqu5dlmwc59z8c6m8y7pnp7lbjhz1mexeuh4sswsl2yidc1637facoq', feed: '7491ad3ed9e3fc8c5f2e2ccfd63164a35cfbab3d54c05b83466f0af60fc36c0c', names: ['docs.orivonstack.eth'], kind: 'site' },
  { id: 'element', label: 'Element', ipns: 'k51qzi5uqu5diqloayyi8qyovpykwr5hi3yiqd3buutb697ldlkry0da5442zf', feed: '6a192f1025cd3391c591c85a10582bd07a61a2a9510c40f0af6847680797a31f', names: ['element.orivonstack.eth'], kind: 'site', port: 'element' },
  { id: 'explore', label: 'Orivon Explore', ipns: 'k51qzi5uqu5dlswot3wcjo7k3vy02gepnrdw2qhu2a3f6ll422kykyoljjshuv', feed: 'f79d2e9a5e61ecaeeecb65ce2726c40dd768488565dfa7f0838fd636e7358f16', names: ['explore.orivonstack.eth'], kind: 'site' },
  { id: 'freetube', label: 'FreeTube', ipns: 'k51qzi5uqu5dhdec4hp7v8rkef3615rmptylrzzqaqw9nn84gf3ljg1omaf5gv', feed: '5924814bb3c9c42b1260c6fa60db262f5fc3cce35315f73ea7e907befad70253', names: ['freetube.orivonstack.eth'], kind: 'site', port: 'freetube' },
  { id: 'ledgerwallet', label: 'Ledger Wallet', ipns: 'k51qzi5uqu5dl3wewviuttup4hjmsjjmkx2d1x93vg8xc66jpqenwjvfckimn8', feed: '06b631f76dc2b990a5d88b519d3f2a663c53aeaa149254f641ff29725d41d7a5', names: ['ledgerwallet.orivonstack.eth'], kind: 'site', port: 'ledger-wallet' },
  { id: 'fluux', label: 'Fluux Messenger', ipns: 'k51qzi5uqu5dlfcpm07vlr8hxq98dzbzouo8lk6f0sr0ke36l59ldlo3963d1k', feed: '5b4d38575f50afd0ff2979dcab73e5715bfda9e027d7480c8aecc884652a4486', names: ['fluux.orivonstack.eth'], kind: 'site', port: 'fluux' },
  { id: 'ollamagui', label: 'Ollama GUI', ipns: 'k51qzi5uqu5dhsqsyy8dm81bwcsq1u92lokberaot95h2m1u65qvppo8eqn9n1', feed: '69b032a2aacf6856879fbbdd0186eb97b5c44af86d2c1882ce9ea855e813e067', names: ['ollamagui.orivonstack.eth'], kind: 'site', port: 'ollamagui' },
  { id: 'restfox', label: 'Restfox', ipns: 'k51qzi5uqu5dkx37ggac238vegz5he9zewa1hfotts10bcdvvut5nbvm0ocg0v', feed: '87b951db1a0c35a1eb497e9a395710bef5c1f49e32b0e0f9c7fff07114de855b', names: ['restfox.orivonstack.eth'], kind: 'site', port: 'restfox' },
  { id: 'share', label: 'Orivon Share', ipns: 'k51qzi5uqu5dk76chs8br3rk768h6jqt2xh9jpnfej0sdzo2u5m27p1vsk7t95', names: ['share.orivonstack.eth'], kind: 'site', port: 'share' },
  { id: 'superproductivity', label: 'Super Productivity', ipns: 'k51qzi5uqu5dha8rosyxovt0160w0gliayzly59vwbeqq6m8d7q03e2r2oncgk', feed: '5c2c1a0092fb6ee0932e1e2a14e7fc0c71dba38efe3a140db639a27475a77315', names: ['superproductivity.orivonstack.eth'], kind: 'site', port: 'superproductivity' },
  { id: 'wikifolder', label: 'TiddlyWiki (Node.js server)', ipns: 'k51qzi5uqu5dhehzkep8jv9vuclexwbuvd2cbgxo6yb70za5qywrilhhywculq', feed: '20316de33dab6bd88afd21f554164dc75d5bbde8286081159edb97c81e1bdd8d', names: ['wikifolder.orivonstack.eth'], kind: 'site', port: 'wikifolder' },
  { id: 'zennotes', label: 'ZenNotes', ipns: 'k51qzi5uqu5dlqowixc6u3tk3cvn5nuxm7svoxr96yuid52j4pxv81m3lyzrhy', feed: 'a1d8e2556db5d29e42c29bc61b5a54e30dba9aaf094a79cef42a4a793a54aa13', names: ['zennotes.orivonstack.eth'], kind: 'site', port: 'zennotes' },
  { id: 'torsocks', label: 'TorSocks', ipns: 'k51qzi5uqu5dgv2lz8svb6ax6g3ntxstidnm5bekw30eo53zllxnrhe2wr53o1', feed: 'c560e659764e82ec47819fc2dd59e0cb4d1631dd2b7b053c433a13b99fef33ec', names: ['torsocks.eth'], kind: 'site', port: 'torsocks' },
  { id: 'thelounge', label: 'The Lounge', ipns: 'k51qzi5uqu5dksrrt6x02airgazw9fhir1uewul6or1fn7v9zixnfngu47thhp', feed: 'd8f69f06edf583f4acc2a25606a5b738afd69de3fc99cfc00773f0cf1679acd3', names: ['thelounge.orivonstack.eth'], kind: 'site', port: 'the-lounge' },
  { id: 'web3-score', label: 'Orivon Attila', ipns: 'k51qzi5uqu5dli7gc98gxy6jlbarijipfrw1x8z2wfyre3rvhssxvzeummkaff', feed: '19eb80c6f0d2fd151f6d253fe0aba7c0153abe4e78ed5599a8d2a1d6d0881e0d', names: ['attila.orivonstack.eth'], kind: 'site' },
  { id: 'website', label: 'Orivon website', ipns: 'k51qzi5uqu5djxiia8zinifneni196scn18sggx6aqh0df5fgd84eh47ok38sn', feed: '66f2adca3031aceb422c74af49e0b9dced1bd43edb2cdbb04b83dc97e729ff1e', names: ['orivonstack.eth', 'www.orivonstack.eth', 'download.orivonstack.eth'], kind: 'site' },
  { id: 'webtorrent', label: 'WebTorrent', ipns: 'k51qzi5uqu5dm0v7emn6w75m1jiq7d3e1f4mpulzxslvinf2vupzhnlzz6m2b6', feed: '1364d27a64a9e63bba20359fca48de008bd1997288d8140c0bb2a1fcd1d948a0', names: ['webtorrent.orivonstack.eth'], kind: 'site', port: 'webtorrent' },
  { id: 'latest-release', label: 'Newest release', ipns: 'k51qzi5uqu5dk0x8gxde5wj1emumph2nv110mwa5uo1qv7st6nfpg4pf5ckk0h', feed: '8740d0565645d42727a9c5efce1c3b10c9f252572c32e1ebe11c18b409643808', names: ['latest.orivonstack.eth'], kind: 'folder' },
  { id: 'status', label: 'Orivon Status', ipns: 'k51qzi5uqu5dh386n6jw6dolvnxvxp5s1x9c0mhf8igbgvbahcnnxtkjz4qnml', feed: 'fb21f431bc92f13bea4c9a16e255a2c9b9309d24258dd89bc0bb2d6284a32eb3', names: ['status.orivonstack.eth'], kind: 'site' }
]

/** The repository whose recipes pin the apps, and the branch the pins are read from. */
export const PORTS = { repo: 'OrivonBrowser/orivon-ports', branch: 'main' }

/** The Web3 Score provider whose evaluations the page reads: Orivon Attila, by its ipns:// key. */
export const SCORE_PROVIDER = { key: 'k51qzi5uqu5dli7gc98gxy6jlbarijipfrw1x8z2wfyre3rvhssxvzeummkaff' }

/** How long an answer from GitHub is reused, so a few visits an hour stay inside its unauthenticated limit. */
export const GITHUB_CACHE_MS = 60 * 60 * 1000

/** The newest `keep` releases that carry an IPFS address must be served. */
export const RELEASES = { repo: 'OrivonBrowser/orivon-mvp', keep: 3 }

/** Public gateways, in the order they are tried. Pinata serves blocks but not IPNS records. */
export const GATEWAYS = ['https://ipfs.orbitor.dev', 'https://ipfs.filebase.io', 'https://gateway.pinata.cloud']

/** Gateways that also serve IPNS records. */
export const RECORD_GATEWAYS = ['https://ipfs.orbitor.dev', 'https://ipfs.filebase.io']

/** The public IPFS routing service: asked only who provides a CID (its IPNS answers lack reliable CORS headers). */
export const ROUTING = 'https://delegated-ipfs.dev'

/** Ethereum JSON-RPC endpoints, in the order they are tried. */
export const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://rpc.mevblocker.io']

export const GITHUB_API = 'https://api.github.com'

/** Every host the page contacts: the manifest's https.connect list is exactly this, plus ":443". */
export const HOSTS = [...new Set([...GATEWAYS, ...RPCS, ROUTING, GITHUB_API].map((url) => new URL(url).host))]

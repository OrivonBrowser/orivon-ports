# `apps/explore/`: where the site icons come from

Explore is this repository's own page and holds no code of anyone else's. The one thing in it
that is a third party's is [`site/icons/`](site/icons/): each listed site's own icon, the mark
that site's pages name for a browser tab or a home screen, or, for an Orivon app, the icon in the
upstream project's source at the commit its recipe pins. Each mark belongs to the site's owner and
is shown only to name the site beside it; a listing is not an endorsement. An owner who wants
their icon changed or removed can open an issue.

Each icon was taken once from the address below (`ipfs://` or `bzz://` for a file in the site's own
content, `inline in` for an icon written into the page itself), then shrunk or enlarged to an opaque 96 x 96
tile: one that fills its square is kept edge to edge, one drawn on transparency is set on a white
plate, or a dark one when the icon itself is light. A site whose pages name no icon, or whose icon
could not be fetched from its content, keeps a tile drawn here: its initials on a colour taken
from its id. `test/catalog.test.ts` keeps this table, the icon files and the catalog 1:1.

| Site | Icon taken from |
|---|---|
| `0xferrous` | drawn here |
| `aave` | <https://app.aave.com/favicon.svg> |
| `across` | <https://across.to/favicon.svg> |
| `actualbudget` | <https://github.com/actualbudget/actual/blob/2bebdbaae0b701120a8cad9d56aafd64fa04c577/packages/desktop-electron/icons/icon.png> |
| `aerodrome` | <https://aerodrome.finance/svg/AERO/favicon.svg> |
| `aeroxyz` | <ipfs://bafybeiceuzryxw5iq56vndz4brwust2jtingegy2jpbun6jsf22mt2xlpm/favicon.ico> |
| `afo` | <ipfs://bafybeiaiwnhahnik7bne7m3pbfo27eav3a64xsutidigjwoulwb3ieiagm/icon-256.png?v=monogram-a-2> |
| `airgapvault` | <https://github.com/airgap-it/airgap-vault/blob/5bae09fae68f1a6d53c6f363aac2529f0bd1aad3/icons/icon-512.webp> |
| `airswap` | <ipfs://bafybeib35za7f5wgavowqj5upcfsuvurfso3gkoddrvmx5obxwi4dbltvy/logo512.png> |
| `alcove` | <ipfs://bafybeiae5xzocfz6zabhnozqiagexvcfj3qljcwgrzgnblzm3sfsmdmepu/android-chrome-512x512.png> |
| `anoni-docs` | <ipfs://bafybeif4vbhfntjz27fjyvcvbmkchbtip5bgig6xzbtdw4yj3vssv4wi2a/favicon.ico> |
| `api3` | <ipfs://bafybeibzhmtxvo2bmi4e4apjuueb5ri7g5f2xn3wiyfrhjdm6vrpdksw4u/favicon.ico> |
| `apoorv` | <ipfs://bafybeieekzmrklmlk24pmvp6iqluugn4ab45o45e727vc23l6nz3tpypue/favicon.png> |
| `ardrive` | <https://ardrive.io/brand/favicon.png> |
| `armagan` | drawn here |
| `arweave` | <https://arweave.org/favicon.svg> |
| `asgardex` | <https://github.com/asgardex/asgardex-desktop/blob/bc7b037d9875e6cfb1721bea577a16f72e1e02ea/resources/icon.png> |
| `assertions` | <ipfs://bafybeibn4bv4mr76z5y4v6x4y33i5wxussak4tyjgmp6qjgcx6r62fe5gi/apple-touch-icon.png> |
| `audius` | <https://audius.co/favicons/android-chrome-512x512.png> |
| `augustol` | <ipfs://bafybeiaexl44v36jwoxescfuhr3goivjflvdz3opd5p4l2gvvekpuvwgg4/assets/handWhite.ico> |
| `austinvernon` | drawn here |
| `banny` | <ipfs://bafybeifay6gaxeha3fv2xpdjzlsbtkigu6xvio6koehi6hklabiel66aka/avatar.png?t=1743181520> |
| `basepaint-xyz` | drawn here |
| `beeport` | <bzz://bah5acgzavx7aoqsu42licajoh5jc4ule2c3juyf4tfzousdr3kmokdvcea5a/favicon.png> |
| `benwoodall` | <ipfs://bafybeiherjqput5zo4zs3aolffoydi7cfdnsu7x3stm4buhs2c4njfjoem/images/favicon.ico> |
| `billiard` | drawn here |
| `blockscout` | <https://eth.blockscout.com/assets/favicon/android-chrome-192x192.png> |
| `buildsite` | <ipfs://bafybeifuyvntplhsf4rs7bfawvljdatypr4ttwfnfqlaqew334bermd7mq/icons/mark-180.png> |
| `cactus` | <https://www.tally.xyz/favicon.ico> |
| `cellwall` | <https://content.wrappr.wtf/ipfs/bafybeibuct6mftnmgzkbn4tq47elpokbkahkjxq7z6qceptlcsvpxletou> |
| `chainlist` | <https://chainlist.org/favicon.ico> |
| `chaskin` | <ipfs://bafybeih5tkewx5ems5jsuygc3kd62sucr73tdxs35yzvszna4wcigr6cai/favicon.ico?favicon.0b3bf435.ico> |
| `chrismg` | <ipfs://bafybeig3avyo2fiifulrhy4qrbviko5u7dotbj3ojr4f2boyyhrihp45s4/favicon.png> |
| `cid-inspector` | <ipfs://bafybeifyb455wffkjworiorlzmwnhv6fupkvtld2u6jzkbxvt7tklj2nvi/favicon.ico> |
| `cipher-gate` | <ipfs://bafybeiaxjoldd3ebfvrwo7bcefijx5rgkpmpqyuomdo5vh56ogqrexp6ei/icon.svg?icon.12ymx-y5uyd1q.svg> |
| `complexity` | <ipfs://bafybeiedtlxiqby25jh4j5x64cgij6ym6eaacr6entjmz2lc4dklgzk5mm/assets/apple-touch-icon.png> |
| `cowswap` | <https://swap.cow.fi/favicon-light-mode.png> |
| `curve` | <https://www.curve.finance/android-chrome-512x512.png> |
| `dapprank` | <ipfs://bafybeicjwmvde4qnqkhewrxfabryushxwzfgy5uy4a2ur36cvopfw7rl2m/favicon.ico> |
| `deboot-efi` | drawn here |
| `debootd` | drawn here |
| `defillama` | <https://defillama.com/favicon.ico> |
| `devcon` | <https://devcon.org/favicon.svg> |
| `dezent` | <ipfs://bafybeiapgkum2m25t32nhntho26g7wmhmayka7vlsoo6efxv5thjsdbow4/icons/icon-512x512.png?v=2cd6e72472e91fd8dc06cb59eb651ffc> |
| `dinamic` | <https://sapphire-naval-quelea-174.mypinata.cloud/ipfs/bafybeiarvaczogtqwxkprx5m4cjabyfdwuj7q4patnjhsoxoffteofg43q> |
| `dotc` | <ipfs://bafybeidcxsyha6rotpfauux3d34lzwedrrqu4wjcs5kklrdw3mdfro7v3i/favicon.ico> |
| `dromos` | <ipfs://bafybeiferfvitauarelwfrvbfur4jijw5yiqkydy2uiql6kyoyoe6qdmaa/apple-touch-icon.png> |
| `dune` | <https://mintlify.s3.us-west-1.amazonaws.com/dune/_generated/favicon/apple-touch-icon.png?v=3> |
| `dxdao` | <ipfs://bafybeidqll2xrx2o6e5zzvlifxvzpy7aopqjxojiccgvtpnl5frxalphvy/favicon.ico> |
| `efp` | <https://docs.efp.app/favicon.ico> |
| `efs` | <ipfs://bafybeiehnviixu674bvbazajj27x2kffn7gswn2rfms62juaa6ijywu6pm/favicon.svg> |
| `eibriel` | drawn here |
| `element` | <https://github.com/element-hq/element-web/blob/ed0a1239e8531243f479529a056872da7889e248/apps/desktop/build/icon.png> |
| `ens` | <https://app.ens.domains/favicon.svg> |
| `ens-docs` | <https://docs.ens.domains/img/icon.svg> |
| `ens-ensjs` | <https://ensjs.ens.eth.link/favicon.ico> |
| `ensinterviews` | drawn here |
| `ensrates` | inline in <ipfs://bafybeigkyaep5p4dg37nl65shiiaqnqbfvwf57w4mlyw5kyqwhrom5bfxi/> |
| `envpledge` | <ipfs://bafybeif7poetf6pfz3q7xkmszigenilgqdm5lrq3aqcyxenz6tz2nisgza/icon.svg> |
| `erc7730` | drawn here |
| `erc8004learning` | <ipfs://bafybeiejmdvwfbrk5rhu46trs56crdsk7xtzihmyo4yhy4x563px46pjtu/favicon.svg> |
| `erc8213` | <ipfs://bafybeiey6lgimibd6x6yjyadniinyzdvkbpwzvsr4jswm4flk6wbvj4pdu/apple-icon.png?apple-icon.0s~0~cy52o33s.png> |
| `eternalsafe` | <ipfs://bafybeie35n6rokcysg6e7vfwhebxgrbrdmnnla4qjvqby7vn3yups3ldqa/favicons/android-chrome-384x384.png> |
| `ethercana` | drawn here |
| `ethereumorg` | <https://ethereum.org/images/assets/manifest-app-icon.svg> |
| `etherphunks` | <ipfs://bafybeid5uzcdmkohd3m332xs6sxrc3tykeglkoxtesn4k4y7zcdmas7wgi/favicon.ico> |
| `etherscan` | <https://etherscan.io/favicon.ico> |
| `ethhub` | drawn here |
| `ethlimo` | <https://framerusercontent.com/images/eCHuIWPGIW5uNvxr4dS0QkB3GE.svg> |
| `ethmumbai` | <https://www.ethmumbai.in/favicon.png> |
| `ethpage` | <https://metadata.ens.domains/mainnet/avatar/ethpage.eth> |
| `extrawdw-zhihu` | drawn here |
| `fairdatasociety` | <bzz://bah5acgza2qzxwaqwgcb7pkiwaqjcvldfcqasntasiwzm4bqcmsl3ogz2mpdq/favicon.ico> |
| `fairfooddata` | <bzz://bah5acgzaclp5t3s3vmenu32ornjy5b5fpwhyd6twvejheobpffbdu7l72tkq/favicon.svg> |
| `farcaster` | <https://farcaster.xyz/1024x1024-v2.png> |
| `filecoin` | <https://www.filecoin.io/favicon.ico?f6c315e33b40e98f> |
| `filecoincloud-projectgutenberg` | drawn here |
| `filestamp` | <ipfs://bafybeie3hsehf7ut44qgcysfrz7w33njodb2vuye6skyg3eyjcixaimkma/apple-touch-icon.png> |
| `fileverse` | <https://fileverse.io/favicon.svg> |
| `filipv` | <ipfs://bafybeibcnv725mvs5d4ho4scrdbgfjisa7lde5dkvdi3jvh4ggzsi2pybq/avatar.png> |
| `fluux` | <https://github.com/processone/fluux-messenger/blob/f900aba2eb56f49bd1a5c379d7f396e285278d17/apps/fluux/public/icon-192.png> |
| `foc-dashboard` | drawn here |
| `focil` | <ipfs://bafybeih3vnjutnueboxrq5qvgfzmiu6uczbglgbhurhwdyt5tzuxwkcblm/assets/images/logo.png> |
| `freetube` | <https://github.com/FreeTubeApp/FreeTube/blob/60e9d7fa186d2cad88f999e5b728cad0fa2e420c/_icons/iconColor.png> |
| `fxn` | <ipfs://bafybeigxoiczvpwfi5sskrftp3j643uvpazybj2rcwutfyk5hees2jrnna/images/favicon.ico> |
| `gamedb` | <ipfs://bafybeifsbdgsz7ykidhdad5vbngdbl7mll3w7c4cqluejaluwb676okze4/avatar.png> |
| `gitcoin` | <https://gitcoin.co/favicon.ico?favicon.8042adbc.ico> |
| `gnoma` | <ipfs://bafybeiazz5aloc2gxkjcs6kohohpkexn6jewgxyuipfnyboi4f2xi46y3q/apple-touch-icon.png> |
| `gnosisvpn` | <ipfs://bafybeih5gihptqlszwq2mdfuih3mllbwhu4a3gsvp57ywtmiexbjlemsvy/img/favicon.ico> |
| `gregskril` | <https://gregskril.com/img/favicon-128.png> |
| `hey` | <https://static.hey.xyz/images/app-icon/0.png> |
| `himchenhim` | inline in <ipfs://bafybeidn3rynn4gr44wujyma6gcwwqattf2i32pmajawgleektit3k3pdi/> |
| `hop` | <ipfs://bafybeifkpmerpae2nxb7gfhceyg722rdtyjybmb3fi3ucc75uxqwaxbtga/images/hop_logo_192x192.png> |
| `horswap-2` | <ipfs://bafybeibtdjzmhx77pxlpmy7fqnwyb7dmrtwbk3n6fpyw3qdgmxaznzwm44/images/512x512_App_Icon.png> |
| `hoverfly` | <bzz://bah5acgzarvq36xmv4xd24gijso57nsiwiyrsb7xs26xmnuspbsk3yao7oika/__up__/logo.svg> |
| `immutablefrontends` | drawn here |
| `impersonator` | <ipfs://bafybeiaucij6yh3nbbuxsiimvyanzuaxqcqv2i2tq2sne65ijrcqlwb4e4/icon.png?544f308e7f7cbc33> |
| `interlineal` | drawn here |
| `ipfs` | <https://ipfs.tech/favicon.svg> |
| `ipfs-dist` | <ipfs://bafybeigq57yutnhpvycfifxgrdziygcxvmwmzmlrm2dcpdmemidirzhnta/favicon.ico> |
| `ipfs-docs` | <ipfs://bafybeier6ud42ptljtfaxrdlknktw54b7ohfpg5h33mosxpxjndxs7xzvm/favicon.ico> |
| `ipfs-specs` | <ipfs://bafybeieqikrxw6kjbu2aojxr5ypfzb4gk75pkvrfzef6yiv6jucec427e4/favicon.ico> |
| `ipfsviewer` | inline in <ipfs://bafybeihukhinfpbfj7jvb6lbf2lqgodm4or4p257k55mexl4zguaeqgygm/> |
| `ipld` | <https://ipld.io/favicon.ico> |
| `ipld-explorer` | <ipfs://bafybeiegp5y3iejd5ytk6hh7cbpxfzmide2d7ev3yvvgnla5badl3dgflu/favicon.ico> |
| `ipns-inspector` | <ipfs://bafybeico4krq7qenlkcycpfcwpsnncvshptdbhweevbtggo4timzz6pf7m/favicon.ico> |
| `jalil` | <https://ipfs.vv.xyz/ipfs/QmaetPt9Yd2XKXYq4VyqUc7YaWrnVWaV1uAoBHxbzPcwzR> |
| `jamesbeck` | drawn here |
| `jamescarnley` | <ipfs://bafybeiahrsvfblmcdvurapna2mapbl774utjpfyg6bxe2cqpijxjcpzop4/favicon.svg> |
| `jaybuidl` | drawn here |
| `jinheock` | drawn here |
| `jsonapi` | <ipfs://bafybeicn7yegbpc4l2lcazaa3czed6p6nnldsluizam6nrfphu6rujs37m/namesys.svg> |
| `jthor` | drawn here |
| `juicebox` | <https://juicebox.money/_next/static/media/logo-icon.ae4571fd.svg> |
| `jumper` | <https://jumper.xyz/favicon.svg> |
| `justw` | <ipfs://bafybeierjchshtzzc3dc4nz552bgphxmxcdue7qftvmhqddycqr64g4wym/favicon.webp> |
| `kairosswap` | <ipfs://bafybeidddf3gslnqlbddiaclothgng3tpftgth6jtea6usqxc5gkj63blm/assets/favicon.svg> |
| `kartbala` | inline in <ipfs://bafybeihqxhhom54op5mmjzk3kjg7soadmc5mirel5d5bkf4s5feqk5jq7e/> |
| `klerosscout-app` | <ipfs://bafybeie5v2jwub5rcjaobuvoozdhshaavzjoofkpwlujbp3hqsnihyoca4/favicon.a3b441d3.ico> |
| `l2beat` | <https://l2beat.com/static/icon.c58a8403.svg> |
| `laststep` | inline in <ipfs://bafybeibg2ooqx3vqi3aarkv2xucbm2og53rj2fslcjnbjcig2wac37abjm/> |
| `ledger-wallet` | <https://github.com/LedgerHQ/ledger-live/blob/abed962b08ca4b746f20192b28ce5b6c06a6c6a4/apps/ledger-live-desktop/build/icons/icon@256x256.png> |
| `lido` | <https://stake.lido.fi/favicon-1080x1080.svg> |
| `liudon` | <ipfs://bafybeibaqvyidpyanjktgf2igdi5zy6dlvuynn3a5scndokyfzpf2ou37a/apple-touch-icon.png> |
| `livecoding-app` | <bzz://bah5acgzangiq7a7gibswrcdcla7njbmb7q6tg4jgwltfqkpg73ys5lkm6eca/icons/apple-icon-180.png> |
| `localsafe` | <ipfs://bafybeid5gtwdn4x5tncvymciszvigxhtmpuw7uwtugdntzacsybngg3uvm/favicon.ico> |
| `logarithmicrex` | <ipfs://bafybeidyxelpnklsdtbo5gukfc34i3vppxi66vqa764ctufscyovss6sf4/apple-touch-icon.png> |
| `luc` | <ipfs://bafybeiczjtsvk6gioflnmqx6rkaowoueece4t4bkxi7fpjenlpqzovymla/favicon.png> |
| `madhavg` | drawn here |
| `mandalas` | <ipfs://bafybeigcm37dmt23dcsyd4akr22fbqj67g4zaaiez5jpgrvuqy2onwamga/pwa/favicon.svg> |
| `menaskop` | drawn here |
| `merklejapan` | drawn here |
| `metamask` | <https://metamask.io/favicons/default/android-chrome-512x512.png> |
| `mnhsu` | <https://i.urusai.cc/yaku8.png> |
| `momack` | <ipfs://bafybeiekeih73k4ajwv64wb6sevlrr33ouwbvzw7xh4gmotvf4gfpb36da/favicon.svg> |
| `monetsupply` | drawn here |
| `mrree` | drawn here |
| `mysticryuujin` | <ipfs://bafybeieloefe5xrvk5cdl6qf366ksv3x52y4o2n3pokpkb66yq3q5j7mty/favicon.svg> |
| `mythosgame` | drawn here |
| `namewhisperai-scorched` | drawn here |
| `nani-ie` | drawn here |
| `nanjingmassacre` | drawn here |
| `nbrseven-loopdash` | <ipfs://bafybeidh3dgdxemzbcitaej2i5cdbw6wily52kvto3rsvdgpjd7yqzslli/icon-512.png> |
| `ncookie` | <ipfs://bafybeibferfjdur5fqqcjjbuubgn5dumaoeyjjndv6etwocty5kvvbarvu/favicon.png> |
| `ndeto` | drawn here |
| `netlibrary` | drawn here |
| `nook-drive` | <bzz://bah5acgzaofgn67vkwsdcsdxdhadd277xbmk54rd2nfk6fg2lsjg54nn3j4yq/assets/apple-touch-icon.png> |
| `oliverrenwick` | <ipfs://bafybeihk644eozn6sn7tqxalcctqyauvrcndltwtbjifyicefw4a3322cu/favicon.ico> |
| `olivida` | <ipfs://bafybeiepkt4mz2go6es7ng6wnvquvbrbhlrl7dfx6ltumsiac7f2ruvzhu/avatar.png> |
| `ollama-gui` | <https://github.com/HelgeSverre/ollama-gui/blob/b79a7b8ca537037d1985c69109260ff540b88170/public/favicon/android-chrome-192x192.png> |
| `omnipin` | <bzz://bah5acgzafz6bqnrqmolgyeddilqlousfaulyzobpe2ztkwxktiot3dkjy6ua/favicon.svg> |
| `oneinch` | <https://1inch.com/favicon/favicon.svg> |
| `ontheswarm-d2` | <bzz://bah5acgzaxpffso6wlvaj3caqvxrbsm55p3cashgu4vqpizwhbidgohlenf4q/favicon.ico> |
| `ontheswarm-excalidraw` | <bzz://bah5acgzab535od4slmqdqubxldhwqem26ofovaarkawxij3qyvvqmm24dx7q/apple-touch-icon.png> |
| `ontheswarm-git` | drawn here |
| `ontheswarm-hydra` | drawn here |
| `ontheswarm-prompt` | <bzz://bah5acgzaoec4xqgtksw7jdz7hi5km33jeu6awx4l5acxlrzpqwyblhdohlyq/favicon.ico> |
| `openscan` | <ipfs://bafybeidh6kbbkbqqjnbzg3lpwyl4iljwiiiz4crircphztlpph7watuzo4/openscan-logo.png> |
| `opensea` | <https://opensea.io/icons/icon-192x192.png> |
| `origin` | <https://www.originprotocol.com/favicon.ico> |
| `orivon` | <ipfs://bafybeibkwwl4osvvuhwoha5qinyjib5dobqoevfd2f2bfxcxzvwgmi5sfy/assets/img/icon-180.png> |
| `orivon-docs` | <https://docs.orivonstack.eth.limo/img/orivon-icon.png> |
| `orivon-latest` | <ipfs://bafybeibkwwl4osvvuhwoha5qinyjib5dobqoevfd2f2bfxcxzvwgmi5sfy/assets/img/icon-180.png> |
| `orivon-status` | <ipfs://bafybeic3fmg34oyg3i4dgyqdbp3uiiwaigwb7vottq6eznc3yvuwvaz67m/icon.svg> |
| `owencampbell` | drawn here |
| `paragraph` | <https://paragraph.com/assets/brand/favicon.svg> |
| `paulmillr` | <ipfs://bafybeigreifgw52o5qgdq7sy3vlh3gi3anrujcda7sbmxp5jc3rpyc4sd4/favicon.ico> |
| `pieceofpi` | <https://gateway.pinata.cloud/ipfs/QmX67wgZNf7ArzqBv1meGuC65pUu85LUfc4DKFZvNNWdgh> |
| `pinme` | <ipfs://bafybeih732i62xph3ul4zrorx6xv7mbqgahdjuifzgvrncmlxfc5zodx4a/favicon.ico> |
| `planet` | <https://www.planetable.xyz/assets/icon-192.png> |
| `playhh` | <ipfs://bafybeic2bbxewn6ovu36nk3t2v52jwn66ikttd3y2uh3p7le6dbhqgven4/assets/favicon-BGmAgdZ3.svg> |
| `poap` | <https://poap.xyz/android-chrome-512x512.png> |
| `projectdavi` | <ipfs://bafybeibddbldzdbkzt3nudrnioalohygluxz432l3ganicivkaxkzzdiq4/favicon.ico> |
| `pxlvre-gramr` | inline in <ipfs://bafybeibbc5besypzjftv4z3jgd5u5n7dnvuazd2ljhemcgxitwpicmk7xy/> |
| `rabby` | <https://rabby.io/assets/images/favicon.png> |
| `raffy` | <ipfs://bafybeigwepyt4j7hbnrj3fyi263cu53kx2jrdqsgrsbdonnzl62t6xrxz4/favicon.ico> |
| `railoxide` | <ipfs://bafybeif2kurqnxedktcjlqisxjcepll5ijvbrq24ztip4tvlwpsnz47d6q/assets/img/app-icon-256.png> |
| `rainbow` | <https://rainbow.me/assets/favicon.png> |
| `rainboy` | drawn here |
| `reality` | <ipfs://bafybeiapygr75kndtqcjgirmjj6bxfvijiswjjby5hehymzfir7e3dobgy/icon.png> |
| `rekt` | <https://raw.githubusercontent.com/RektHQ/Assets/main/images/favicon.png> |
| `remix` | <https://remix.ethereum.org/assets/img/remix-logo-blue.png> |
| `reneil` | <ipfs://bafybeifv3osn5satmqe7o7gccgthxkgt2264rehccbzfx5paun7a5y6vaa/favicon.ico> |
| `restfox` | <https://github.com/flawiddsouza/Restfox/blob/0fffd36d2f95dc6c5efd890469f2f1a6433ff433/packages/ui/public/pwa-192x192.png> |
| `resupply` | <https://resupply.finance/favicon.svg> |
| `revnet` | <https://www.revnet.app/assets/img/small-bw.svg> |
| `revoke` | <https://revoke.cash/assets/images/android-chrome-512x512.png> |
| `ricmoo` | drawn here |
| `rocketsweep` | <ipfs://bafybeifx45lmgm2nd36anj7wjvzcombx4d4vdb5cpqsvwvzg3za3ojgpnu/favicon.ico> |
| `rockopera-color` | drawn here |
| `ronan` | <ipfs://bafybeicdp4k4ygepdb3se65nc3dccpi3kj5wsjf22f23z56qfi3untvnma/maskable_icon_512x512.png> |
| `safe` | <https://app.safe.global/favicons/android-chrome-512x512.png> |
| `safenet-explorer` | <ipfs://bafybeihrqubibslgdvugihqindemueyn6y3qiix4d5ouns3pdkkxodiiqi/logo192.png> |
| `safenetstake` | <ipfs://bafybeicii64zufd6a4sm6trx2kmk4khrnq6syp6lz5ppt6ljwr5q4ut6oq/favicon.svg> |
| `sanleo` | <ipfs://bafybeidsi7faja2zfqpnt66xzvudtihmkdajqqpkx6sbuxt3qmzi6ex6ou/images/icon.png> |
| `scottrepreneur-me` | <ipfs://bafybeibjojt72jamac3dkxmhbvchmg3m6f64gv3fm2kzgmgmmz7ywxu4ri/favicon.png> |
| `seedit` | <https://seedit.app/apple-touch-icon.png> |
| `sha512rma` | <ipfs://bafybeifncqh5ho542wq2e7fkbptff6fmcrfaosltk7y3prfpsdog5i2hsq/favicon.ico> |
| `shaurya` | drawn here |
| `showmehow` | <ipfs://bafybeiap7cwvkf6sxhbmjeh2akyo7iea3jgjbc4ubgpg2aqad3y34p4sk4/apple-touch-icon.png> |
| `simplepage` | <ipfs://bafybeih35kufar7qoh437usra2fhtqbhroczngcjlvf77tznbcjkzkuba4/_files/.artifacts/ensAvatar.png> |
| `slopcomputer` | <ipfs://bafybeihmnqzg6budyog4abcxnsncxbphma5ihkcawz2mvgpng7zrvcerxa/favicon.png> |
| `slotray` | <ipfs://bafybeigwglj7vjhjusoxtgzdno5okucd6by6xh5ckyrmbscziajtamvzyu/icon.svg?7fe0cf84dcd42725> |
| `smokesignal` | <ipfs://bafybeigd6em26itq3v6kz2gvwjnng6eygeb36ih7wrb32bh4mxdibcacwy/favicon.svg> |
| `snapshot` | <https://snapshot.box/favicon.svg> |
| `stackly` | <ipfs://bafybeidpn53iznpgs5yr6gg2owog3jzxbk2hrk3oqyg6m4jufymgvrzyuq/favicon.ico> |
| `status` | <https://status.app/icon.png?1dfb84a82ad5dcee> |
| `steg-dnssec` | drawn here |
| `stevedylan` | <https://stevedylan.dev/android-chrome-512x512.png> |
| `stewards` | <ipfs://bafybeihwgsd5mydatswicl7pyuwfwziu6bb67lcxxu6pv64pauxf253v5m/assets/ethereum.svg> |
| `storagebeat` | drawn here |
| `storopoli` | <ipfs://bafybeidq6alzb47dbobmxmo7bu2nxmoxvv3rk7niyb3lxwgixsjwbzwobu/favicon.svg> |
| `stuckfunds` | inline in <ipfs://bafybeigfj56gyr5u5a3yiljxtrbp5ch7nyt27kttvttpip5ss7vam67bnq/> |
| `swapr` | <ipfs://bafybeieiwbszcjx5j6z3373krzbxmzacbagathnsljtokpx62n5rfcqmr4/favicon.png> |
| `superproductivity` | <https://github.com/super-productivity/super-productivity/blob/466a426700e7402f8628bc80ce499d3de6160dbb/src/assets/icons/icon-96x96.png> |
| `swarm` | <bzz://bah5acgzazgeq7msizgibloyfw4uncsrgrvtlpbhxhuxe7muky3cfnfw4x2wa/favicon.png> |
| `swarm-docs` | <bzz://bah5acgzau7rw576sl4dumma4p2lh4navywjci3v75usxk6f4oqwtfo3teicq/img/favicon.ico> |
| `swarm-wikipedia` | drawn here |
| `swarm-workshops` | <bzz://bah5acgzacg7nkvycm4ykaepxevb6gsroyifclpnxxxlusudf76ein6u46igq/assets/Mark_Orange.png> |
| `t4t` | drawn here |
| `takens-perpetual` | inline in <ipfs://bafybeihbh5enxkvxu76sirnbjo66jpv4kp7ncnluzzjk5b5eogg7k27tam/> |
| `teamomega` | <ipfs://bafybeigyxdvxmfddtepcjw3xiutpvp5q3w3fjdfz6czoguojqvjhmxhaty/assets/favicon.ico> |
| `thedaonft` | <ipfs://bafybeie7ebqloof4uzvavwua572ybvtguzghqi5uyy6tjxqqqvvnjarwpi/img/thedao-icon.png> |
| `thelounge` | <https://github.com/thelounge/thelounge/blob/14590bfda615b3f3ee0ee8301a404d79a8076743/client/public/img/logo-transparent-bg.svg> |
| `thurinlabs` | <ipfs://bafybeihdupn5ye5hg3djlpvsu4kxt4ojafat6do37jamr2tdi6tdhkhjfi/images/favicon.svg> |
| `thurinlabs-docs` | <ipfs://bafybeibhsp46xocv6kkadpxjk3bqzzbrqq6vqkr3t7hjz4wlire5gjszva/favicon.svg> |
| `thurinlabs-id` | <ipfs://bafybeiare2mktdivnw5td2d6hzfamofqm3oj63otyqd6h5mghl7bhcbuha/favicon.svg> |
| `tieout` | drawn here |
| `trustlessness` | drawn here |
| `ubi` | inline in <ipfs://bafybeigogimfdloykhwp5drgijpbmk7ed7l6okwvls3cu73sc4losw4pge/> |
| `ultrasound` | <https://ultrasound.money/favicon.png> |
| `uniswap` | <https://cdn.app.uniswap.org/images/512x512_App_Icon.png> |
| `uppies` | drawn here |
| `usconstitution` | drawn here |
| `ustas` | <ipfs://bafybeidunuaxw2igocrxcfzg7x4ubuffbdvvyukynqc3icb5nxdq2ufkdm/favicon.svg> |
| `v1rtl` | <ipfs://bafybeifaacimfxna75ngyssypimjlegd4bduif7cnkbt3qv6re5g66pknm/emoji.webp> |
| `vanshs` | inline in <ipfs://bafybeidwysyvptpbqqkr7b3cq6ar2t6hdgauivtjmjhhzyusjni455hyxm/> |
| `velodrome` | <https://velodrome.finance/svg/VELO/favicon.svg> |
| `victor42` | <https://cdn.victor42.work/assets/favicon.ico> |
| `vitalik` | <ipfs://bafybeigqyo555suvqi3scc2izft3mozskktbtkzs2xghoe2rpxetxbbdiq/images/icon.png> |
| `walletbeat` | <https://www.walletbeat.fyi/favicon.ico> |
| `wealdtech` | <ipfs://bafybeiakrm2levbf5om4pjoarxznwpht6hvwtj4t3nft3db7brv3lglwvu/favicon.ico> |
| `web3audio-normalizer` | inline in <ipfs://bafybeibends4aonswbasuwvtjfe5rrmy7qb52riuizbg6awbz6adf3qgey/> |
| `web3privacynow` | <ipfs://bafybeihnyyjy4ixvsqb2eco7dh3qxtn6ehnp7zj6hmtptbz4ye6awiutpa/_assets/images/logo.svg> |
| `webhash` | <https://webhash.com/favicon.svg> |
| `webtorrent` | <https://github.com/webtorrent/webtorrent-desktop/blob/6c91af345d4bd62603d7063ea02a50394d64af0d/static/WebTorrent.png> |
| `wesl-ee` | <ipfs://bafybeidu6pohujkjx3kbgzkonugipfhe57hxyedt5pbyiy52oxxddefqgm/favicon.ico> |
| `whispery` | inline in <bzz://bah5acgzawjqjrxeaggdhsmo7a6khjynixwuvllbxtlzp4nchertzn56shpeq/> |
| `winterlock` | inline in <ipfs://bafybeiabk3zuqfiwdnisnghngeic7ifsaoythm2mmbmgdytblpnazbgd6m/> |
| `woco-app` | <bzz://bah5acgzastelsj36j4h4rgidzu4auj6ke5otuduha2ftkax72ovo7t5f4kia/icons/apple-touch-icon.png> |
| `yieldbasis` | <ipfs://bafybeiakr4pr4yhamlq2wn7ogzefy7pg27wv75iqgzo7dbpjjpatjmpnlm/icons/apple-touch-icon.png> |
| `z0r0z` | drawn here |
| `zennotes` | <https://github.com/ZenNotes/zennotes/blob/9e2c651c9bddd9dd71dcbd161a4018ce102d96cd/apps/desktop/build/icon.png> |
| `zeugh` | drawn here |
| `zknox` | drawn here |
| `zlaser` | inline in <ipfs://bafybeiajneapq75yma2bsjaz2iluanh3xciq6akj6276ufuj6yc76g4gpi/> |
| `zora` | <https://zora.co/assets/favicon/apple-touch-icon.png> |

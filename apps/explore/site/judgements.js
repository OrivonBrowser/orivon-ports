// The Web3 Score judgements this page shows when Orivon gives it none from the user's own
// provider: Orivon Attila's website levels, read from its published files on the day below.
// Data only. A `website` key is a provider identifier, `cid:` plus a CID a site in catalog.js is
// listed at. An `ens` key is a .eth name catalog.js lists, with the CID it pointed to that day.

export const SNAPSHOT = {
  provider: 'Orivon Attila V0.0.1',
  address: 'ipns://k51qzi5uqu5dli7gc98gxy6jlbarijipfrw1x8z2wfyre3rvhssxvzeummkaff/score',
  read: '2026-10-10',
  /** @type {Readonly<Record<string, number>>} */
  website: {
    'cid:bafybeiapptln3qdfg2ubwh7lxj6zgxc3s3fc4qb7k3wucfcq7tbqdp7h3u': 3, // ASGARDEX
    'cid:bafybeicqymfv47eg7aphl3luwen3tpdosb622m7kwsnt4rkfacagnpbymu': 4, // AirGap Vault
    'cid:bafybeicub3q45zdnvlnnivi574mnh4vujo2fwxcxnf4yegqp2rc7heijey': 3, // The Lounge
    'cid:bafybeiejev3mbko3dqbjoihrvctufjikokb6ql5zobt47ok5vtjcyh3ig4': 3, // Element
    'cid:bafybeihy4h5vkixrhepxqsizvoh4nuyopc2j7ypp7rk4zkxr23lvdilnzq': 3, // FreeTube
    'cid:bafybeiecrn6fiachnh2jb45ewedm7izswjfofhqiw5yowstjjnvwu7espm': 4, // WebTorrent
    'cid:bafybeig2qwvk3zseuwbnm76hs66nzgueb74eqvnc5fnx5lbtzco6m3fl44': 2, // Aave
    'cid:bafybeifutotmr72fttru6r4hsrhr44q4qit3vovb7brv4dy5754y4cl6zq': 2 // Safe
  },
  /** @type {Readonly<Record<string, { cid: string, level: number }>>} */
  ens: {
    'cowswap.eth': { cid: 'bafybeib77kqm53u6qpfczltq56iqbswwtgxqi435e4redd3cdgydkvtbui', level: 2 },
    'hop.eth': { cid: 'bafybeifkpmerpae2nxb7gfhceyg722rdtyjybmb3fi3ucc75uxqwaxbtga', level: 2 },
    'swap.eth': { cid: 'bafybeib35za7f5wgavowqj5upcfsuvurfso3gkoddrvmx5obxwi4dbltvy', level: 2 },
    'swapr.eth': { cid: 'bafybeieiwbszcjx5j6z3373krzbxmzacbagathnsljtokpx62n5rfcqmr4', level: 2 },
    'resupply.eth': { cid: 'bafybeiedkg5xxxysibyzr2bzobzkdap2gizrk7aq2mozjyqv5yk7uuk7uq', level: 2 },
    'aero.drome.eth': { cid: 'bafybeihlcmsi6l4i7g5brdr2wet4j6wic77mnmoldgnk3p3pt5g2lugrii', level: 2 },
    'velo.drome.eth': { cid: 'bafybeibf66myaaw64ottwtbxh6cxnck34pdefpkrifyo5uht3thhihdjam', level: 2 },
    'stackly.eth': { cid: 'bafybeidpn53iznpgs5yr6gg2owog3jzxbk2hrk3oqyg6m4jufymgvrzyuq', level: 2 },
    'rocketsweep.eth': { cid: 'bafybeifx45lmgm2nd36anj7wjvzcombx4d4vdb5cpqsvwvzg3za3ojgpnu', level: 2 },
    'eternalsafe.eth': { cid: 'bafybeie35n6rokcysg6e7vfwhebxgrbrdmnnla4qjvqby7vn3yups3ldqa', level: 3 },
    'beta.walletbeat.eth': { cid: 'bafybeiecddp4agiwwqbya5qji7tzlfnp3jksf4tbw4jeabrvitzluzljgm', level: 4 },
    'app.ens.eth': { cid: 'bafybeiho37vhh7qnzrs2drjuasagbebojgbx7467ag5aktifdhhz7smc2q', level: 2 },
    'seedit.eth': { cid: 'bafybeihsu5pjlof2xjrnfc7onqrsf4zjb4tgelcx44qo52uncelgeojeky', level: 3 },
    'smokesignal.eth': { cid: 'bafybeigd6em26itq3v6kz2gvwjnng6eygeb36ih7wrb32bh4mxdibcacwy', level: 2 },
    'alcovetools.eth': { cid: 'bafybeiae5xzocfz6zabhnozqiagexvcfj3qljcwgrzgnblzm3sfsmdmepu', level: 3 },
    'api3.eth': { cid: 'bafybeibzhmtxvo2bmi4e4apjuueb5ri7g5f2xn3wiyfrhjdm6vrpdksw4u', level: 2 },
    'dxdao.eth': { cid: 'bafybeidqll2xrx2o6e5zzvlifxvzpy7aopqjxojiccgvtpnl5frxalphvy', level: 2 },
    'projectdavi.eth': { cid: 'bafybeibddbldzdbkzt3nudrnioalohygluxz432l3ganicivkaxkzzdiq4', level: 3 },
    'revnet.eth': { cid: 'bafybeihf7nllybo3e2fb5c5etwc2dxvt5ydxbolnpjvfxo74sjtqi4n6ju', level: 2 },
    'banny.eth': { cid: 'bafybeifay6gaxeha3fv2xpdjzlsbtkigu6xvio6koehi6hklabiel66aka', level: 3 },
    'etherphunks.eth': { cid: 'bafybeid5uzcdmkohd3m332xs6sxrc3tykeglkoxtesn4k4y7zcdmas7wgi', level: 2 },
    'mandalas.eth': { cid: 'bafybeigcm37dmt23dcsyd4akr22fbqj67g4zaaiez5jpgrvuqy2onwamga', level: 3 },
    'webhash.eth': { cid: 'bafybeig45aqpm4lzjmxkafiujwma6kpniiseuzec65em7hvbumsnsuc2eu', level: 3 },
    'ipld.eth': { cid: 'bafybeiejnahivksp7lksmpfbl4anfsywx2zlqx2xlfch5xq5226iw3dvnq', level: 2 },
    'simplepage.eth': { cid: 'bafybeih35kufar7qoh437usra2fhtqbhroczngcjlvf77tznbcjkzkuba4', level: 3 },
    'pinme.eth': { cid: 'bafybeih732i62xph3ul4zrorx6xv7mbqgahdjuifzgvrncmlxfc5zodx4a', level: 2 },
    'planetable.eth': { cid: 'bafybeiaq7c7dnu3f5w5vrt5hblowwa5jaefz7tk2e72awx5f3q7gwsjska', level: 2 },
    'app.efs.eth': { cid: 'bafybeiehnviixu674bvbazajj27x2kffn7gswn2rfms62juaa6ijywu6pm', level: 3 },
    'fileverse.eth': { cid: 'bafybeihad3i5ia6l7rkjiucrlde2jakpluujhwd2n366ppy723uzun6qne', level: 3 },
    'storagebeat.eth': { cid: 'bafybeiftl6ixglhmrh32nj4irw473t65vewmcupw72sx7ditzectuevv7i', level: 3 },
    'openscan.eth': { cid: 'bafybeidh6kbbkbqqjnbzg3lpwyl4iljwiiiz4crircphztlpph7watuzo4', level: 3 },
    'dapprank.eth': { cid: 'bafybeicjwmvde4qnqkhewrxfabryushxwzfgy5uy4a2ur36cvopfw7rl2m', level: 3 },
    'remix.ethereum.eth': { cid: 'bafybeianiyelez5ncziqssvciyndefwp5fjeh6bmutu7gq3lf6coif4tle', level: 2 },
    'docs.ens.eth': { cid: 'bafybeibmcu52uovuzmmy3yugwcc77jkbbdl7q5yrq2a4yupmefjpnq2rva', level: 2 },
    'immutable-frontends.eth': { cid: 'bafybeic5icomycnns3layg3ihdeejxrdtgv2aixra4qf24wwgqwcqqw27y', level: 2 },
    'reality.eth': { cid: 'bafybeiapygr75kndtqcjgirmjj6bxfvijiswjjby5hehymzfir7e3dobgy', level: 3 },
    'jsonapi.eth': { cid: 'bafybeicn7yegbpc4l2lcazaa3czed6p6nnldsluizam6nrfphu6rujs37m', level: 3 },
    'docs.vpn.gnosis.eth': { cid: 'bafybeih5gihptqlszwq2mdfuih3mllbwhu4a3gsvp57ywtmiexbjlemsvy', level: 3 },
    'devcon.eth': { cid: 'bafybeibj3porjg5eat6qayz7sn25a6rzfaqb3umg45sqlzpppshyrm22nq', level: 3 },
    'ethmumbai.eth': { cid: 'bafybeieylhlp2msd7q2xs2kl5q4wal5ymkr6lyjonnogexuvhbx43huram', level: 2 },
    'ethhub.eth': { cid: 'bafybeibiksiuod2y2hjuywoobfojmkddfhyzqrw4fgilha2nxnyzzisliq', level: 2 },
    'meetfocil.eth': { cid: 'bafybeih3vnjutnueboxrq5qvgfzmiu6uczbglgbhurhwdyt5tzuxwkcblm', level: 2 },
    'ensinterviews.eth': { cid: 'bafybeid5mst6zvo7gya4pt24iq2q2w75ad3pyr4rlsrcg4jj5ug4elxvhu', level: 4 },
    'vitalik.eth': { cid: 'bafybeigqyo555suvqi3scc2izft3mozskktbtkzs2xghoe2rpxetxbbdiq', level: 3 },
    'ricmoo.eth': { cid: 'bafybeihatfz6rspdshfqmo6wmvbvnzsobtwo26cyukniyanrmxrquxvvxy', level: 4 },
    'wealdtech.eth': { cid: 'bafybeiakrm2levbf5om4pjoarxznwpht6hvwtj4t3nft3db7brv3lglwvu', level: 2 },
    'gregskril.eth': { cid: 'bafybeihqxu6v2zzmmgl5gqlzpozu2ss6gh53idcdp7vnq5lccnjcxf3o3e', level: 3 },
    'raffy.eth': { cid: 'bafybeigwepyt4j7hbnrj3fyi263cu53kx2jrdqsgrsbdonnzl62t6xrxz4', level: 4 },
    'v1rtl.eth': { cid: 'bafybeifaacimfxna75ngyssypimjlegd4bduif7cnkbt3qv6re5g66pknm', level: 2 },
    'jamescarnley.eth': { cid: 'bafybeiahrsvfblmcdvurapna2mapbl774utjpfyg6bxe2cqpijxjcpzop4', level: 4 },
    'ronan.eth': { cid: 'bafybeicdp4k4ygepdb3se65nc3dccpi3kj5wsjf22f23z56qfi3untvnma', level: 4 },
    'stevedylandev.eth': { cid: 'bafybeidelyzmwrfeciizo7txtleditercivgjnzi6oiypxcugzi74a3sum', level: 2 },
    'z0r0z.eth': { cid: 'bafkreicugs5dr24bh22zkwbr4655ocr5illdkstd5jd7ydbditjqeykysu', level: 3 },
    'austinvernon.eth': { cid: 'bafybeiddzfrkx5z7jifevmkbivd65kjm36l5g3zgn5qc23munkq3z7wxoe', level: 3 }
  }
}

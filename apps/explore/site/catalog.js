// The directory's data and nothing else: no DOM, no imports. Adding a site is adding a line.
// A site's ens name must carry an IPFS contenthash that loads through a gateway; ipfs is a CIDv1.
// An Orivon app with `published: false` is announced but has no address yet. A port names the
// project it was ported from in `upstream`.

/**
 * @typedef {{ id: string, name: string }} Category
 * @typedef {{ kind: 'native' | 'port', needsOrivon?: boolean, upstream?: string, published?: boolean }} OrivonMark
 * @typedef {{
 *   id: string, name: string, category: string, summary: string,
 *   web?: string, ens?: string, ipfs?: string, orivon?: OrivonMark
 * }} Site
 */

/** @type {readonly Category[]} */
export const CATEGORIES = [
  { id: 'exchange', name: 'Exchange & DeFi' },
  { id: 'wallets', name: 'Wallets' },
  { id: 'names', name: 'Names & identity' },
  { id: 'social', name: 'Social & chat' },
  { id: 'media', name: 'Video & music' },
  { id: 'governance', name: 'Governance & funding' },
  { id: 'nft', name: 'NFTs & creators' },
  { id: 'storage', name: 'Storage & hosting' },
  { id: 'data', name: 'Explorers & data' },
  { id: 'dev', name: 'Developer tools' },
  { id: 'learn', name: 'Learn & community' }
]

/** @type {readonly Site[]} */
export const SITES = [
  { id: 'asgardex', name: 'ASGARDEX', category: 'exchange', ipfs: 'bafybeiek2i5n7n7ksldz6lc56jeku5fwsttj6jv7l527dhrlxwdnw4lpty', orivon: { kind: 'port', needsOrivon: true, upstream: 'https://www.asgardex.com', published: true }, summary: 'Wallet and cross-chain swaps on THORChain' },
  { id: 'uniswap', name: 'Uniswap', category: 'exchange', web: 'https://app.uniswap.org', summary: 'Swap tokens and provide liquidity' },
  { id: 'cowswap', name: 'CoW Swap', category: 'exchange', web: 'https://swap.cow.fi', ens: 'cowswap.eth', summary: 'Batch-settled trades that shield you from MEV' },
  { id: 'curve', name: 'Curve', category: 'exchange', web: 'https://www.curve.finance', ens: 'curve.eth', summary: 'Exchange for stablecoins and other pegged assets' },
  { id: 'aave', name: 'Aave', category: 'exchange', web: 'https://app.aave.com', summary: 'Lend and borrow crypto assets' },
  { id: 'lido', name: 'Lido', category: 'exchange', web: 'https://stake.lido.fi', summary: 'Liquid staking for ether' },
  { id: 'oneinch', name: '1inch', category: 'exchange', web: 'https://1inch.com', summary: 'Swap aggregator that routes across many exchanges' },
  { id: 'across', name: 'Across', category: 'exchange', web: 'https://across.to', summary: 'Bridge assets between Ethereum and its rollups' },
  { id: 'jumper', name: 'Jumper', category: 'exchange', web: 'https://jumper.xyz', summary: 'Cross-chain swaps and bridging' },
  { id: 'airgapvault', name: 'AirGap Vault', category: 'wallets', ipfs: 'bafybeifswtpznor64py5vd5gm5gu26auju4gc23dqxt4waxlyigtgcbweu', orivon: { kind: 'port', needsOrivon: true, upstream: 'https://airgap.it', published: true }, summary: 'Offline signer for a phone kept away from the network' },
  { id: 'metamask', name: 'MetaMask', category: 'wallets', web: 'https://metamask.io', summary: 'Browser-extension and mobile wallet' },
  { id: 'rabby', name: 'Rabby', category: 'wallets', web: 'https://rabby.io', summary: 'Multi-chain wallet that previews every transaction' },
  { id: 'rainbow', name: 'Rainbow', category: 'wallets', web: 'https://rainbow.me', summary: 'Ethereum wallet for phone and browser' },
  { id: 'safe', name: 'Safe', category: 'wallets', web: 'https://app.safe.global', summary: 'Multi-signature smart accounts' },
  { id: 'ens', name: 'ENS', category: 'names', web: 'https://app.ens.domains', summary: 'Register and manage .eth names' },
  { id: 'efp', name: 'Ethereum Follow Protocol', category: 'names', web: 'https://efp.app', summary: 'An on-chain follow graph for Ethereum accounts' },
  { id: 'poap', name: 'POAP', category: 'names', web: 'https://poap.xyz', summary: 'Collectible badges that record events you attended' },
  { id: 'thelounge', name: 'The Lounge', category: 'social', ipfs: 'bafybeieqer67ojhi6q3eiatmrcu3r3mqjehn7hwit2satqjfnljo65fb4q', orivon: { kind: 'port', needsOrivon: true, upstream: 'https://thelounge.chat', published: true }, summary: 'IRC client that connects straight to any network' },
  { id: 'element', name: 'Element', category: 'social', ipfs: 'bafybeifbqmphucl4qe3vpuhnwlyk2pusmdnv5vjs4xumvmshdttrdg2p64', orivon: { kind: 'port', needsOrivon: true, upstream: 'https://element.io', published: true }, summary: 'Matrix chat client: encrypted messaging and rooms' },
  { id: 'farcaster', name: 'Farcaster', category: 'social', web: 'https://farcaster.xyz', summary: 'Decentralised social network' },
  { id: 'hey', name: 'Hey', category: 'social', web: 'https://hey.xyz', summary: 'Social app built on Lens' },
  { id: 'paragraph', name: 'Paragraph', category: 'social', web: 'https://paragraph.com', summary: 'Newsletters and blogs with on-chain publishing' },
  { id: 'status', name: 'Status', category: 'social', web: 'https://status.app', summary: 'Private messenger with a built-in wallet' },
  { id: 'freetube', name: 'FreeTube', category: 'media', ipfs: 'bafybeigcdsumr4jo4j6gxqbg33sd2e3kylnbxqrmepub7iwp3fwjftgoue', orivon: { kind: 'port', needsOrivon: true, upstream: 'https://freetubeapp.io', published: true }, summary: 'Private YouTube client with no ads or tracking' },
  { id: 'audius', name: 'Audius', category: 'media', web: 'https://audius.co', summary: 'Music streaming and uploads run by artists and fans' },
  { id: 'snapshot', name: 'Snapshot', category: 'governance', web: 'https://snapshot.box', summary: 'Gasless voting for DAOs' },
  { id: 'tally', name: 'Tally', category: 'governance', web: 'https://www.tally.xyz', summary: 'On-chain governance for DAOs' },
  { id: 'gitcoin', name: 'Gitcoin', category: 'governance', web: 'https://gitcoin.co', summary: 'Funding for open source and public goods' },
  { id: 'juicebox', name: 'Juicebox', category: 'governance', web: 'https://juicebox.money', summary: 'Programmable treasuries for funding projects' },
  { id: 'opensea', name: 'OpenSea', category: 'nft', web: 'https://opensea.io', summary: 'Marketplace for NFTs' },
  { id: 'zora', name: 'Zora', category: 'nft', web: 'https://zora.co', summary: 'Create and collect onchain media' },
  { id: 'ipfs', name: 'IPFS', category: 'storage', web: 'https://ipfs.tech', ens: 'ipfs.eth', summary: 'Content-addressed peer-to-peer file system' },
  { id: 'filecoin', name: 'Filecoin', category: 'storage', web: 'https://www.filecoin.io', summary: 'Decentralised storage network' },
  { id: 'arweave', name: 'Arweave', category: 'storage', web: 'https://arweave.org', summary: 'Permanent, pay-once data storage' },
  { id: 'ardrive', name: 'ArDrive', category: 'storage', web: 'https://ardrive.io', summary: 'Permanent file storage built on Arweave' },
  { id: 'ethlimo', name: 'eth.limo', category: 'storage', web: 'https://eth.limo', summary: 'Gateway that serves ENS websites over HTTPS' },
  { id: 'webhash', name: 'WebHash', category: 'storage', web: 'https://webhash.com', ens: 'webhash.eth', summary: 'Build a site and publish it to IPFS and ENS' },
  { id: 'etherscan', name: 'Etherscan', category: 'data', web: 'https://etherscan.io', summary: 'Ethereum block explorer' },
  { id: 'blockscout', name: 'Blockscout', category: 'data', web: 'https://eth.blockscout.com', summary: 'Open-source block explorer' },
  { id: 'l2beat', name: 'L2BEAT', category: 'data', web: 'https://l2beat.com', summary: 'Risk analysis of Ethereum rollups' },
  { id: 'defillama', name: 'DefiLlama', category: 'data', web: 'https://defillama.com', summary: 'DeFi analytics across chains' },
  { id: 'dune', name: 'Dune', category: 'data', web: 'https://dune.com', summary: 'Query and chart on-chain data' },
  { id: 'ultrasound', name: 'ultrasound.money', category: 'data', web: 'https://ultrasound.money', summary: 'Ether supply and burn dashboard' },
  { id: 'remix', name: 'Remix IDE', category: 'dev', web: 'https://remix.ethereum.org', summary: 'Write, test and deploy smart contracts in the browser' },
  { id: 'chainlist', name: 'Chainlist', category: 'dev', web: 'https://chainlist.org', summary: 'RPC endpoints and chain IDs for EVM networks' },
  { id: 'revoke', name: 'Revoke.cash', category: 'dev', web: 'https://revoke.cash', summary: 'Review and revoke token approvals' },
  { id: 'ethereumorg', name: 'ethereum.org', category: 'learn', web: 'https://ethereum.org', summary: 'Learn what Ethereum is and how to use it' },
  { id: 'vitalik', name: "Vitalik Buterin's blog", category: 'learn', ens: 'vitalik.eth', summary: 'Essays on Ethereum, cryptography and society' },
  { id: 'devcon', name: 'Devcon', category: 'learn', web: 'https://devcon.org', ens: 'devcon.eth', summary: "Ethereum's developer conference" }
]

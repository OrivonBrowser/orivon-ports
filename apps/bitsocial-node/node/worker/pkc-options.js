// The options pkc-js's RPC server is created with: the Bitsocial desktop clients' own, so a community hosted here
// behaves as one hosted by their desktop node. Their HTTP routers and six `.bso` name resolvers are the same; the
// data directory is this app's, and kubo is the facade's origin. The page sort 5chan's boards use for their bump limit is
// registered besides.

import { BsoResolver } from '@bitsocial/bso-resolver'
import activePageSort from '@pkcprotocol/active-page-sort'
import { ETH_RPC_URLS } from './eth-providers.js'
import { ETHEREUM_ORIGIN } from './ethereum-reads.js'

export { ETH_RPC_URLS }

/**
 * The page sorts a board may name in `settings.pages`. The 5chan board manager keeps a board's bump limit in the options of
 * `@pkcprotocol/active-page-sort`, and pkc-js refuses a board whose settings name a sort the server does not have. A board that
 * names none publishes the pages it always did.
 */
export const PAGE_SORTS = Object.freeze({ '@pkcprotocol/active-page-sort': activePageSort })

export const HTTP_ROUTERS = ['https://routing.lol', 'https://peers.pleb.bot', 'https://peers.plebpubsub.xyz', 'https://peers.forumindex.com']

/** @param {string} provider */
function labelOf (provider) {
  try { return new URL(provider).hostname } catch { return provider }
}

/** @param {string[]} [providers] */
export function createBsoNameResolvers (providers = ETH_RPC_URLS) {
  return providers.map((provider) => new BsoResolver({ key: `eth-${labelOf(provider)}`, provider }))
}

/**
 * The one name resolver of a browser that offers a light client to an app: it asks `ETHEREUM_ORIGIN`, which the Worker answers in its own process, from the light client
 * and, when that cannot answer, from the public servers in order (`ethereum-reads.js`). Its answer is the answer: a name with no record is not asked of the public servers again.
 */
export function createLightClientNameResolvers () {
  return [new BsoResolver({ key: 'eth-orivon', provider: ETHEREUM_ORIGIN })]
}

/**
 * @param {{ dataPath: string, kuboUrl: string, isolated?: boolean, ethRpcUrls?: string[], lightClient?: boolean }} options `kuboUrl`: the origin the facade answers as
 *   kubo, without `/api/v0`; `isolated`: no HTTP routers and no name resolvers, for a run with no internet; `ethRpcUrls`: the providers the
 *   name resolvers ask in place of the desktop clients' six, which only a test sets (a local fork of the chain); `lightClient`: the browser offers a light client, so
 *   the one resolver reads through it
 */
export function desktopPkcOptions ({ dataPath, kuboUrl, isolated = false, ethRpcUrls, lightClient = false }) {
  return {
    dataPath,
    kuboRpcClientsOptions: [{ url: `${kuboUrl}/api/v0` }],
    httpRoutersOptions: isolated ? [] : HTTP_ROUTERS,
    nameResolvers: isolated ? [] : lightClient ? createLightClientNameResolvers() : createBsoNameResolvers(ethRpcUrls),
    pageSorts: { ...PAGE_SORTS }
  }
}
